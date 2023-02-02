# exit when any command fails
set -e

# Build the TypeScript Tangle
(cd tangle_ts; npm run build)

# build the Rust
cargo build --target wasm32-unknown-unknown --release --manifest-path rust_utilities/Cargo.toml

cp rust_utilities/target/wasm32-unknown-unknown/release/rust_utilities.wasm web_example/rust_utilities.wasm


