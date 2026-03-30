/*
 * Copyright (C) 2019-2021 Magnusson Institute
 * Copyright (C) 2022-2026 384, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

const DBG0 = false;

export class LocalStorage {
    private dbName: string;
    private dbPath: string;
    private data: Record<string, any>;
    private currentVersion: number;
    private journalFile: string;
    private flushPromise: Promise<void> | null = null;
    private initPromise: Promise<void>;
    private journalHandle: Deno.FsFile | null = null;

    constructor(dbName: string, private baseDirectory: string = '.') {
        if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
            throw new Error("Invalid database name (alphanumeric and '_' only)");
        }
        this.dbName = dbName;
        this.dbPath = `${this.baseDirectory}/db/${dbName}`;
        if (DBG0) console.log(`++++ creating DB, dbPath: ${this.dbPath}`);
        
        // Find latest version and load state
        const { version, data, needsFlush } = this.findLatestState();
        this.currentVersion = version;
        this.data = data;
        if (DBG0) console.log(`++++ version ${version}, needsFlush: ${needsFlush}`);
        
        // Set up journal file for next version
        this.journalFile = `${this.dbPath}.${this.currentVersion + 1}.journal.txt`;

        // If we detected a crash (journal without DB), flush immediately
        if (needsFlush) {
            // We need to await this, but constructor can't be async
            // So we'll make it a Promise that must be awaited
            this.initPromise = this.flush();
        } else {
            this.initPromise = Promise.resolve();
        }
    }

    private async openJournal() {
        // Close existing if any
        if (this.journalHandle) {
            this.journalHandle.close();
        }
        this.journalHandle = await Deno.open(this.journalFile, {
            create: true,
            append: true,
            write: true
        });
    }

    private findLatestState(): { version: number, data: Record<string, any>, needsFlush: boolean } {
        try {
            if (DBG0) {
                const files0 = [...Deno.readDirSync(`${this.baseDirectory}/db`)].map(f => f.name)
                console.log(`++++ files0: ${files0.join(', ')}`);
            }
            const files = [...Deno.readDirSync(`${this.baseDirectory}/db`)]
                .map(f => f.name)
                .filter(name => name.startsWith(this.dbName));
            if (DBG0) console.log(`++++ files (prefix '${this.dbPath}'): ${files.join(', ')}`);
            
            let maxDbVersion = 999;
            let maxJournalVersion = 999;
            let latestDb: string | null = null;
            let latestJournal: string | null = null;

            for (const file of files) {
                const dbMatch = file.match(/\.(\d+)\.json$/);
                const journalMatch = file.match(/\.(\d+)\.journal\.txt$/);
                
                if (dbMatch) {
                    const version = parseInt(dbMatch[1]);
                    if (version > maxDbVersion) {
                        maxDbVersion = version;
                        latestDb = file;
                    }
                }
                
                if (journalMatch) {
                    const version = parseInt(journalMatch[1]);
                    if (version > maxJournalVersion) {
                        maxJournalVersion = version;
                        latestJournal = file;
                    }
                }
            }

            let data: Record<string, any> = {};
            if (latestDb) {
                data = JSON.parse(Deno.readTextFileSync(`${this.baseDirectory}/db/${latestDb}`));
            }

            // Determine if we need an immediate flush
            if (DBG0) console.log(`++++ maxJournalVersion: ${maxJournalVersion}, maxDbVersion: ${maxDbVersion}`);
            const needsFlush = (latestJournal != null) && ((latestDb === null) || maxJournalVersion > maxDbVersion);

            if (latestJournal) {
                const journal = Deno.readTextFileSync(`${this.baseDirectory}/db/${latestJournal}`);
                for (const line of journal.split('\n')) {
                    if (line.trim()) {
                        const { key, value } = JSON.parse(line);
                        if (value === undefined) {
                            delete data[key];
                        } else {
                            data[key] = value;
                        }
                    }
                }
                maxDbVersion = Math.max(maxDbVersion, maxJournalVersion);
            }

            return { version: maxDbVersion, data, needsFlush };
        } catch (e) {
            console.warn('Error loading state:', e);
            return { version: 999, data: {}, needsFlush: false };
        }
    }

    // All public methods must now await initPromise
    public async setItem(key: string, value: any): Promise<void> {
        await this.initPromise;
        const entry = JSON.stringify({ key, value }) + '\n';

        // testing with handle
        if (!this.journalHandle) { await this.openJournal(); }
        const encoded = new TextEncoder().encode(entry);
        await this.journalHandle!.write(encoded);

        // await Deno.writeFile(this.journalFile, new TextEncoder().encode(entry), { append: true });
        
        if (value === undefined) {
            delete this.data[key];
        } else {
            this.data[key] = value;
        }
    }

    public async getItem(key: string): Promise<any> {
        await this.initPromise;
        return this.data[key];
    }

    public async flush(): Promise<void> {
        // Only one flush operation at a time
        if (this.flushPromise) {
            await this.flushPromise;
            return;
        }

        if (this.journalHandle) {
            this.journalHandle.close();
            this.journalHandle = null;
        }
    
        this.flushPromise = (async () => {
            const nextVersion = this.currentVersion + 1;
            const newDbFile = `${this.dbPath}.${nextVersion}.json`;
            
            // Write new database
            await Deno.writeTextFile(newDbFile, JSON.stringify(this.data));
            
            // Clean up old versions SYNCHRONOUSLY as part of the flush
            const files = [...Deno.readDirSync(`${this.baseDirectory}/db`)].map(f => f.name)
                .filter(name => name.startsWith(this.dbName));
            
            for (const file of files) {
                const match = file.match(/\.(\d+)\.(json|journal\.txt)$/);
                if (match) {
                    const version = parseInt(match[1]);
                    // Delete journals of current DB version or older
                    if (match[2] === 'journal.txt' && version <= this.currentVersion) {
                        await Deno.remove(`${this.baseDirectory}/db/${file}`);
                    }
                    // Delete DBs that are two or more versions behind
                    if (match[2] === 'json' && version <= nextVersion - 2) {
                        await Deno.remove(`${this.baseDirectory}/db/${file}`);
                    }
                }
            }
            
            // Update our state
            this.currentVersion = nextVersion;
            this.journalFile = `${this.dbPath}.${nextVersion + 1}.journal.txt`;
            
            this.flushPromise = null;
        })();
    
        await this.flushPromise;
    }
}



// export class LocalStorage {
//     private dbPath: string;
//     private data: Record<string, any>;
//     private currentVersion: number;
//     private journalFile: string;
//     private flushPromise: Promise<void> | null = null;

//     constructor(dbName: string) {
//         if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
//             throw new Error("Invalid database name (alphanumeric and '_' only)");
//         }
//         this.dbPath = `${OS384_PATH}/db/${dbName}`;
        
//         // Find latest version and load state
//         const { version, data } = this.findLatestState();
//         this.currentVersion = version;
//         this.data = data;
        
//         // Set up journal file for next version
//         this.journalFile = `${this.dbPath}.${this.currentVersion + 1}.journal.txt`;

//         // Kick off async cleanup of old files
//         this.cleanupOldFiles();
//     }

//     private findLatestState(): { version: number, data: Record<string, any> } {
//         try {
//             const files = [...Deno.readDirSync(`${OS384_PATH}/db`)].map(f => f.name)
//                 .filter(name => name.startsWith(this.dbPath));
            
//             // Find latest database version
//             let maxDbVersion = 999;  // Start at 1000 if no DB found
//             let latestDb: string | null = null;
            
//             for (const file of files) {
//                 const match = file.match(/\.(\d+)\.json$/);
//                 if (match) {
//                     const version = parseInt(match[1]);
//                     if (version > maxDbVersion) {
//                         maxDbVersion = version;
//                         latestDb = file;
//                     }
//                 }
//             }

//             // Load the database
//             let data: Record<string, any> = {};
//             if (latestDb) {
//                 data = JSON.parse(Deno.readTextFileSync(`${OS384_PATH}/db/${latestDb}`));
                
//                 // Check for and apply next version's journal if it exists
//                 const nextJournal = `${this.dbPath}.${maxDbVersion + 1}.journal.txt`;
//                 if (files.includes(nextJournal)) {
//                     const journal = Deno.readTextFileSync(`${OS384_PATH}/db/${nextJournal}`);
//                     for (const line of journal.split('\n')) {
//                         if (line.trim()) {
//                             const { key, value } = JSON.parse(line);
//                             if (value === undefined) {
//                                 delete (data as any)[key];
//                             } else {
//                                 (data as any)[key] = value;
//                             }
//                         }
//                     }
//                 }
//             }

//             return { version: maxDbVersion, data };
//         } catch (e) {
//             console.warn('Error loading state:', e);
//             return { version: 999, data: {} };
//         }
//     }

//     private async cleanupOldFiles() {
//         try {
//             const files = [...Deno.readDirSync(`${OS384_PATH}/db`)].map(f => f.name)
//                 .filter(name => name.startsWith(this.dbPath));
            
//             for (const file of files) {
//                 const match = file.match(/\.(\d+)\.(json|journal\.txt)$/);
//                 if (match) {
//                     const version = parseInt(match[1]);
//                     // Delete journals of current DB version or older
//                     if (match[2] === 'journal.txt' && version <= this.currentVersion) {
//                         await Deno.remove(`${OS384_PATH}/db/${file}`);
//                     }
//                     // Delete DBs that are two or more versions behind
//                     if (match[2] === 'json' && version <= this.currentVersion - 2) {
//                         await Deno.remove(`${OS384_PATH}/db/${file}`);
//                     }
//                 }
//             }
//         } catch (e) {
//             console.warn('Error cleaning up old files:', e);
//         }
//     }

//     public async setItem(key: string, value: any): Promise<void> {
//         const entry = JSON.stringify({ key, value }) + '\n';
        
//         // First append to journal
//         await Deno.writeFile(this.journalFile, new TextEncoder().encode(entry), { append: true });
        
//         // Then update in memory
//         if (value === undefined) {
//             delete this.data[key];
//         } else {
//             this.data[key] = value;
//         }
//     }

//     public getItem(key: string): any {
//         return this.data[key];
//     }

//     public async flush(): Promise<void> {
//         // Only one flush operation at a time
//         if (this.flushPromise) {
//             await this.flushPromise;
//             return;
//         }

//         this.flushPromise = (async () => {
//             const nextVersion = this.currentVersion + 1;
//             const newDbFile = `${this.dbPath}.${nextVersion}.json`;
            
//             // Write new database
//             await Deno.writeTextFile(newDbFile, JSON.stringify(this.data));
            
//             // Update our state
//             this.currentVersion = nextVersion;
//             this.journalFile = `${this.dbPath}.${nextVersion + 1}.journal.txt`;
            
//             this.flushPromise = null;
//         })();

//         await this.flushPromise;
//     }
// }


// // fairly primitive. try to use several small ones
// export class LocalStorage {
//     private filePath: string;
//     private data: Record<string, any>;
//     constructor(dbName: string) {
//         if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
//             throw new Error("Invalid database name (alphanumeric and '_' only)");
//         }
//         this.filePath = OS384_PATH + '/db' + dbName + '.json';
//         this.data = this.loadData();
//     }
//     private loadData(): Record<string, any> {
//         try {
//             const text = Deno.readTextFileSync(this.filePath);
//             return JSON.parse(text);
//         } catch {
//             return {};
//         }
//     }
//     private saveData(): void {
//         Deno.writeTextFileSync(this.filePath, JSON.stringify(this.data));
//     }
//     public getItem(key: string): any {
//         return this.data[key];
//     }
//     public setItem(key: string, value: any): void {
//         this.data[key] = value;
//         this.saveData();
//     }
//     public removeItem(key: string): void {
//         delete this.data[key];
//         this.saveData();
//     }
//     public clear(): void {
//         this.data = {};
//         this.saveData();
//     }
// }
