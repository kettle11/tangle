# exit when any command fails
set -e

# build the Rust
cargo build --target wasm32-unknown-unknown --release

cp target/wasm32-unknown-unknown/release/warpcore_mvp.wasm web_example/warpcore_mvp.wasm
cp src/manager.js web_example/manager.js
cp src/room.js web_example/room.js

