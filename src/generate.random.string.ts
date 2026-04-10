#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env

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

import '../keys.js'
import '../config.js'

import { Command } from "https://deno.land/x/cliffy/command/mod.ts";

// @deno-types="../dist/384.esm.d.ts"
import { sbCrypto } from "../dist/384.esm.js"

await new Command()
    .name("generate.random.string.ts")
    .version("1.0.0")
    .description(`
        Generates a random alphanumeric (base62) string.
    `)
    .option("-l, --length <length:number>", "Number of random characters", { default: 32 })
    .action(async ({ length }) => {
        console.log(`Random string (length ${length}):`, sbCrypto.generateRandomString(length));
    })
    .parse(Deno.args);
