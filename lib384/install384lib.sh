#!/bin/bash

# sets up local os384 libraries; copies locally in case you're developing
# there, otherwise fetches from (dev) server

# TODO: upload lib384 to production (384.world) server

URL_FOR_LIB384_D_TS="https://c3.384.dev/api/v2/page/u2d23u7w/384.esm.d.ts"
URL_FOR_384_ESM_JS="https://c3.384.dev/api/v2/page/7938Nx0wM39T/384.esm.js"

local_lib384_d_ts="../../lib384/dist/384.esm.d.ts"
local_384_esm_js="../../lib384/dist/384.esm.js"

local_lib_map="../../lib384/dist/384.esm.js.map"

# Check if 384.esm.d.ts exists locally
if [ -f "$local_lib384_d_ts" ]; then
    cp "$local_lib384_d_ts" 384.esm.d.ts
else
    echo "384.esm.d.ts not found locally, downloading from $URL_FOR_LIB384_D_TS"
    curl -O "$URL_FOR_LIB384_D_TS" || wget "$URL_FOR_LIB384_D_TS"
fi

# Check if 384.esm.js exists locally
if [ -f "$local_384_esm_js" ]; then
    cp "$local_384_esm_js" 384.esm.js
else
    echo "384.esm.js not found locally, downloading from $URL_FOR_384_ESM_JS"
    curl -O "$URL_FOR_384_ESM_JS" || wget "$URL_FOR_384_ESM_JS"
fi

# Check if there's a local map file
if [ -f "$local_lib_map" ]; then
    cp "$local_lib_map" 384.esm.js.map
fi