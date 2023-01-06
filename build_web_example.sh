# exit when any command fails
set -e

# build the Rust
cargo build --target wasm32-unknown-unknown --release 
cargo build --target wasm32-unknown-unknown --release --manifest-path=example_script/Cargo.toml

cp target/wasm32-unknown-unknown/release/warpcore_mvp.wasm web_example/warpcore_mvp.wasm
cp example_script/target/wasm32-unknown-unknown/release/example_script.wasm web_example/example_script.wasm
cp src/manager.js web_example/manager.js
cp src/room.js web_example/room.js

