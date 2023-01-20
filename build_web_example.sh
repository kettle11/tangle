# exit when any command fails
set -e

# Build the TypeScript WarpCore
(cd warp_core_ts; npm run build)

# build the Rust
cargo build --target wasm32-unknown-unknown --release 
# RUSTFLAGS='-C target-feature=+bulk-memory' \
  cargo +nightly build --target wasm32-unknown-unknown -Z build-std=std,panic_abort --release --manifest-path=example_script/Cargo.toml

cp target/wasm32-unknown-unknown/release/warpcore_mvp.wasm web_example/warpcore_mvp.wasm
cp example_script/target/wasm32-unknown-unknown/release/example_script.wasm web_example/example_script.wasm


