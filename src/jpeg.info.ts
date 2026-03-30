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

// minor utility, parses jpeg header

// @deno-types="../dist/384.esm.d.ts"
import * as __ from "../dist/384.esm.js"

const filePath = Deno.args[0]

try {
  const data = await Deno.readFile(filePath);
  const bytes = new Uint8Array(data.buffer);
  const metaData = __.browser.images.readJpegHeader(bytes);
  console.log(metaData);
} catch (err) {
  console.error(`Failed to read file at ${filePath}`, err);
}
