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

export {};

declare global {
  interface MouseEvent {
    readonly clientX: number;
    readonly clientY: number;
    readonly screenX: number;
    readonly screenY: number;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly button: number;
    readonly buttons: number;
  }

  interface DataTransfer {
    dropEffect: string;
    effectAllowed: string;
    readonly items: DataTransferItemList;
    readonly types: ReadonlyArray<string>;
    clearData(format?: string): void;
    getData(format: string): string;
    setData(format: string, data: string): void;
  }

  interface DataTransferItemList {
    length: number;
    add(data: string | Blob, type?: string): DataTransferItem | null;
    remove(index: number): void;
    clear(): void;
    [index: number]: DataTransferItem;
  }

  interface DataTransferItem {
    readonly kind: string;
    readonly type: string;
  }

  interface DragEvent extends MouseEvent {
    readonly dataTransfer: DataTransfer | null;
  }

  interface Attr {
    readonly localName: string;
    readonly name: string;
    readonly namespaceURI: string | null;
    value: string;
    readonly ownerElement: Element | null;
    readonly prefix: string | null;
    readonly specified: boolean;
  }

  interface NamedNodeMap {
    length: number;
    getNamedItem(qualifiedName: string): Attr | null;
    item(index: number): Attr | null;
    removeNamedItem(qualifiedName: string): Attr;
    setNamedItem(attr: Attr): Attr | null;
    [index: number]: Attr;
  }

  interface DOMTokenList {
    length: number;
    add(...tokens: string[]): void;
    remove(...tokens: string[]): void;
    toggle(token: string, force?: boolean): boolean;
    contains(token: string): boolean;
    item(index: number): string | null;
    toString(): string;
    [index: number]: string;
  }

  interface CSSStyleDeclaration {
    cssText: string;
    length: number;
    getPropertyValue(property: string): string;
    getPropertyPriority(property: string): string;
    setProperty(property: string, value: string, priority?: string): void;
    removeProperty(property: string): string;
    item(index: number): string;
    [index: number]: string;
  }

  interface Element {
    readonly attributes: NamedNodeMap;
    readonly classList: DOMTokenList;
    readonly className: string;
    readonly id: string;
    readonly tagName: string;
  }

  interface HTMLElement extends Element {
    readonly style: CSSStyleDeclaration;
    readonly offsetHeight: number;
    readonly offsetWidth: number;
  }

  interface Document {
    createElement(tagName: string): HTMLElement;
    getElementById(id: string): HTMLElement | null;
    querySelector(selectors: string): Element | null;
  }

  interface IDBDatabase {
    readonly name: string;
    readonly version: number;
    close(): void;
  }

  type IDBValidKey = number | string | Date | BufferSource | IDBValidKey[];

  type IDBTransactionMode = "readonly" | "readwrite" | "versionchange";

  interface IDBObjectStore {
    readonly name: string;
    readonly keyPath: string | string[] | null;
    readonly indexNames: DOMStringList;
    readonly autoIncrement: boolean;
  }
}