
const decoder = new TextDecoder();

export class RustUtilities {
    private _rust_utilities: WebAssembly.WebAssemblyInstantiatedSource;

    constructor(rust_utilities: WebAssembly.WebAssemblyInstantiatedSource) {
        this._rust_utilities = rust_utilities;
    }

    static async setup(): Promise<RustUtilities> {

        const imports = {
            env: {
                external_log: function (pointer: number, length: number) {
                    const memory = rust_utilities.instance.exports.memory as WebAssembly.Memory;
                    const message_data = new Uint8Array(memory.buffer, pointer, length);
                    const decoded_string = decoder.decode(new Uint8Array(message_data));
                    console.log(decoded_string);
                },
                external_error: function (pointer: number, length: number) {
                    const memory = rust_utilities.instance.exports.memory as WebAssembly.Memory;
                    const message_data = new Uint8Array(memory.buffer, pointer, length);
                    const decoded_string = decoder.decode(new Uint8Array(message_data));
                    console.error(decoded_string);
                },
            }
        };
        const rust_utilities = await WebAssembly.instantiateStreaming(fetch("rust_utilities.wasm"), imports);
        return new RustUtilities(rust_utilities);
    }

    gzip_decode(data_to_decode: Uint8Array) {
        const memory = this._rust_utilities.instance.exports.memory as WebAssembly.Memory;
        const instance = this._rust_utilities.instance.exports;

        const pointer = (instance.reserve_space as CallableFunction)(data_to_decode.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_decode.byteLength);
        destination.set(data_to_decode);

        (instance.gzip_decode as CallableFunction)();
        const result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        const result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        return new Uint8Array(result_data);
    }


    // TODO: These are just helpers and aren't that related to the rest of the code in this:
    gzip_encode(data_to_compress: Uint8Array) {
        const memory = this._rust_utilities.instance.exports.memory as WebAssembly.Memory;
        const exports = this._rust_utilities.instance.exports;

        const pointer = (exports.reserve_space as CallableFunction)(data_to_compress.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_compress.byteLength);
        destination.set(new Uint8Array(data_to_compress));

        (exports.gzip_encode as CallableFunction)();
        const result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        const result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        // console.log("COMPRESSED LENGTH: ", result_data.byteLength);
        // console.log("COMPRESSION RATIO: ", data_to_compress.byteLength / result_data.byteLength);
        return result_data;
    }


    hash_data(data_to_hash: Uint8Array): Uint8Array {
        const memory = this._rust_utilities.instance.exports.memory as WebAssembly.Memory;
        const instance = this._rust_utilities.instance.exports;

        const pointer = (instance.reserve_space as CallableFunction)(data_to_hash.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_hash.byteLength);
        destination.set(new Uint8Array(data_to_hash));

        (instance.xxh3_128_bit_hash as CallableFunction)();
        const hashed_result = new Uint8Array(new Uint8Array(memory.buffer, pointer, 16));
        return hashed_result;
    }

    process_binary(wasm_binary: Uint8Array, export_globals: boolean, track_changes: boolean) {
        if (!(export_globals || track_changes)) {
            return wasm_binary;
        }

        const length = wasm_binary.byteLength;
        const pointer = (this._rust_utilities.instance.exports.reserve_space as CallableFunction)(length);

        const memory = this._rust_utilities.instance.exports.memory as WebAssembly.Memory;

        const data_location = new Uint8Array(memory.buffer, pointer, length);
        data_location.set(new Uint8Array(wasm_binary));
        (this._rust_utilities.instance.exports.prepare_wasm as CallableFunction)(export_globals, track_changes);

        // TODO: Write these to an output buffer instead of having two calls for them.
        const output_ptr = (this._rust_utilities.instance.exports.get_output_ptr as CallableFunction)();
        const output_len = (this._rust_utilities.instance.exports.get_output_len as CallableFunction)();
        const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);
        return output_wasm;
    }
}