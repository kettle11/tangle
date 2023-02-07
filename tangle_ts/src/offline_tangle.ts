const WASM_PAGE_SIZE = 65536;

type WasmSnapshot = {
    memory: Uint8Array,
    // The index in the exports and the value to set the export to
    globals: Array<[number, unknown]>,
}

export type TimeStamp = {
    time: number,
    player_id: number,
};

export function time_stamp_compare(a: TimeStamp, b: TimeStamp): number {
    let v = Math.sign(a.time - b.time);
    if (v != 0) {
        return v;
    }

    v = Math.sign(a.player_id - b.player_id);
    if (v != 0) {
        return v;
    }

    return 0;
}

export type FunctionCall = {
    hash_after?: Uint8Array,
    name: string,
    args: Array<number>,
    time_stamp: TimeStamp,
    // Used if the 'WasmSnapshot' RollBackStrategy is used.
    wasm_snapshot_before?: WasmSnapshot
};

type UpcomingFunctionCall = {
    function_name: string,
    args: Array<number>,
    time_stamp: TimeStamp,
}

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

export class OfflineTangle {
    /// The user Wasm that Tangle is syncing 
    wasm_instance: WebAssembly.WebAssemblyInstantiatedSource;
    current_time = 0;
    recurring_call_time = 0;
    function_calls: Array<FunctionCall> = [];
    rust_utilities: RustUtilities;

    // Optionally track hashes after each function call
    hash_tracking = true;

    private _recurring_call_interval = 0;
    private _recurring_call_name?: string = "fixed_update";
    private _imports: WebAssembly.Imports = {};
    private _upcoming_function_calls: Array<UpcomingFunctionCall> = [];

    private constructor(wasm_instance: WebAssembly.WebAssemblyInstantiatedSource, rust_utilities: RustUtilities) {
        this.wasm_instance = wasm_instance;
        this.rust_utilities = rust_utilities;
    }

    static async setup(wasm_binary: Uint8Array, imports: WebAssembly.Imports, recurring_call_interval: number): Promise<OfflineTangle> {
        const rust_utilities = await RustUtilities.setup();

        // TODO: These imports are for AssemblyScript, but they should be optional
        // or part of a more fleshed-out strategy for how to manage imports.
        imports.env ??= {};

        imports.env.abort ??= () => {
            console.log("Ignoring call to abort");
        };
        imports.env.seed ??= () => {
            // TODO: Add more entropy
            return 14;
        };
        let external_log: (a: number, b: number) => void = () => { console.log("Not implemented") };
        imports.env.external_log ??= (a: number, b: number) => external_log(a, b);

        wasm_binary = rust_utilities.process_binary(wasm_binary, true, false);
        const wasm_instance = await WebAssembly.instantiate(wasm_binary, imports);

        const tangle = new OfflineTangle(wasm_instance, rust_utilities);
        tangle._recurring_call_interval = recurring_call_interval;
        tangle._imports = imports;

        console.log("[tangle] Heap size: ", (wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer.byteLength);

        // TODO: Think more about what 'standard library' Wasm should be provided.
        external_log = (pointer: number, length: number) => {
            const memory = tangle.wasm_instance.instance.exports.memory as WebAssembly.Memory;
            const message_data = new Uint8Array(memory.buffer, pointer, length);
            const decoded_string = decoder.decode(new Uint8Array(message_data));
            console.log(decoded_string);
        };

        // When a module is setup call its main function immediately.
        // This may only be useful for Rust.
        const main = wasm_instance.instance.exports["main"];
        if (main) {
            (main as CallableFunction)();
        }

        return tangle;
    }

    async assign_memory(new_memory_data: Uint8Array) {
        const mem = this.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
        let page_diff = (new_memory_data.byteLength - mem.buffer.byteLength) / WASM_PAGE_SIZE;

        // The only way to "shrink" a Wasm instance is to construct an entirely new 
        // one with a new memory.
        // Hopefully Wasm gets a better way to shrink instances in the future.

        if (page_diff < 0) {
            const old_instance = this.wasm_instance.instance;
            this.wasm_instance.instance = await WebAssembly.instantiate(this.wasm_instance.module, this._imports);
            page_diff = (new_memory_data.byteLength - (this.wasm_instance?.instance.exports.memory as WebAssembly.Memory).buffer.byteLength) / WASM_PAGE_SIZE;

            // Copy over all globals during the resize.
            for (const [key, v] of Object.entries(old_instance.exports)) {
                if (key.slice(0, 3) == "wg_") {
                    (this.wasm_instance.instance.exports[key] as WebAssembly.Global).value = v;
                }
            }

            // TODO: Copy Wasm tables as well.
        }

        const old_memory = this.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
        if (page_diff > 0) {
            old_memory.grow(page_diff);
        }
        new Uint8Array(old_memory.buffer).set(new_memory_data);
    }

    async reset_with_new_program(wasm_binary: Uint8Array, current_time: number) {
        wasm_binary = await this.rust_utilities.process_binary(wasm_binary, true, false);

        this.wasm_instance = await WebAssembly.instantiate(wasm_binary, this._imports);
        // console.log("[tangle] Binary hash of new program: ", this.hash_data(wasm_binary));

        // When a module is setup call its main function immediately.
        // This may only be useful for Rust.
        const main = this.wasm_instance.instance.exports["main"];
        if (main) {
            (main as CallableFunction)();
        }

        this.function_calls = [];

        // TODO: It might be better to not reset time here.
        this.current_time = current_time;
        this.recurring_call_time = 0;
    }

    /// Restarts the Tangle with a new memory.
    async reset_with_wasm_memory(new_memory_data: Uint8Array, new_globals_data: Map<number, number>, current_time: number, recurring_call_time: number) {
        this.assign_memory(new_memory_data);

        const exports = this.wasm_instance.instance.exports;

        for (const [key, value] of new_globals_data) {
            (exports[`wg_global_${key}`] as WebAssembly.Global).value = value;
        }

        this.function_calls = [];

        this.current_time = current_time;
        this.recurring_call_time = recurring_call_time;
    }

    remove_history_before(time: number) {
        let i = 0;
        for (i = 0; i < this.function_calls.length; i++) {
            const f = this.function_calls[i];
            if (f.time_stamp.time >= time) {
                break;
            }
        }

        // Always leave one function call for debugging purposes.
        this.function_calls.splice(0, i - 1);
    }

    steps_remaining(time_to_progress: number): number {
        return (((this.current_time + time_to_progress) - this.recurring_call_time) / this._recurring_call_interval);
    }

    read_memory(address: number, length: number): Uint8Array {
        return new Uint8Array(new Uint8Array((this.wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer, address, length));
    }

    read_string(address: number, length: number): string {
        const message_data = this.read_memory(address, length);
        const decoded_string = decoder.decode(new Uint8Array(message_data));
        return decoded_string;
    }

    async progress_time(time_progressed: number) {
        // time_progressed is repurposed as a resimulation budget.
        this.current_time += time_progressed;

        // Add recurring function calls
        if (this._recurring_call_name && this._recurring_call_interval > 0) {
            while ((this.current_time - this.recurring_call_time) > this._recurring_call_interval) {
                this.recurring_call_time += this._recurring_call_interval;

                const time_stamp = {
                    time: this.recurring_call_time,
                    player_id: 0
                };

                this._upcoming_function_calls.push({
                    function_name: this._recurring_call_name,
                    time_stamp,
                    args: []
                });
            }
        }

        this._upcoming_function_calls.sort((a, b) => (time_stamp_compare(a.time_stamp, b.time_stamp)));

        // TODO: Assertion for duplicate time stamps.

        // TODO: Estimate how long a fixed update takes and use that to not spend too much computation.
        const start_time = performance.now();

        while (this._upcoming_function_calls[0] && this._upcoming_function_calls[0].time_stamp.time < this.current_time) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const function_call = this._upcoming_function_calls.shift()!;

            //  console.log("CALLING %s", function_call.function_name, function_call.time_stamp);

            await this._call_inner(function_call.function_name, function_call.time_stamp, function_call.args);

            const time_now = performance.now();
            if ((start_time - time_now) > (time_progressed * 0.75)) {
                console.log("[tangle] Bailing out of simulation to avoid missed frames")
                break;
            }
        }
    }

    private async _apply_snapshot(wasm_snapshot_before: WasmSnapshot) {
        if (wasm_snapshot_before) {
            // Apply snapshot
            this.assign_memory(wasm_snapshot_before.memory);

            const values = Object.values(this.wasm_instance.instance.exports);

            for (let j = 0; j < wasm_snapshot_before.globals.length; j++) {
                (values[wasm_snapshot_before.globals[j][0]] as WebAssembly.Global).value = wasm_snapshot_before.globals[j][1];
            }
        }
    }

    private _get_wasm_snapshot(): WasmSnapshot {
        // This could be optimized by checking ahead of time which globals need to be synced.
        const globals: Array<[number, unknown]> = [];
        let j = 0;
        for (const [key, v] of Object.entries(this.wasm_instance.instance.exports)) {
            if (key.slice(0, 3) == "wg_") {
                //  console.log("SNAP SHOT: ", [j, (v as WebAssembly.Global).value]);
                globals.push([j, (v as WebAssembly.Global).value]);
            }
            j += 1;
        }
        return {
            // This nested Uint8Array constructor creates a deep copy.
            memory: new Uint8Array(new Uint8Array((this.wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer)),
            globals
        };

    }

    private async _call_inner(function_name: string, time_stamp: TimeStamp, args: number[]): Promise<number> {
        // If this function does not exist don't bother calling it.
        if (!this.wasm_instance?.instance.exports[function_name]) {
            // TODO: Returning 0 isn't correct
            return 0;
        }

        // Rewind any function calls that occur after this.
        let i = this.function_calls.length;
        for (; i > 0; i--) {
            // Keep going until a timestamp less than `time_stamp` is found.
            const function_call = this.function_calls[i - 1];
            if (time_stamp_compare(function_call.time_stamp, time_stamp) == -1) {

                if (this.function_calls[i]) {
                    // This will only happen if we're using the WasmSnapshot RollbackStrategy.
                    const wasm_snapshot_before = this.function_calls[i].wasm_snapshot_before;
                    if (wasm_snapshot_before) {
                        this._apply_snapshot(wasm_snapshot_before);
                    }
                }
                break;
            }
        }


        const function_call = this.wasm_instance?.instance.exports[function_name] as CallableFunction;
        if (function_call) {
            const wasm_snapshot_before = this._get_wasm_snapshot();

            function_call(...args);

            let hash_after;

            if (this.hash_tracking) {
                hash_after = this.hash();
            }

            this.function_calls.splice(i, 0, {
                name: function_name,
                args: args,
                time_stamp: time_stamp,
                wasm_snapshot_before,
                hash_after
            });

        }

        // Replay any function calls that occur after this function
        for (let j = i + 1; j < this.function_calls.length; j++) {
            const f = this.function_calls[j];
            // Note: It is assumed function calls cannot be inserted with an out-of-order offset by the same peer.
            // If that were true the offset would need to be checked and potentially updated here.

            const wasm_snapshot_before = this._get_wasm_snapshot();


            (this.wasm_instance?.instance.exports[f.name] as CallableFunction)(...f.args);

            if (this.hash_tracking) {
                f.hash_after = this.hash();
            }

            f.wasm_snapshot_before = wasm_snapshot_before;
        }
        return i;
    }

    /// Returns the function call of this instance.
    async call_with_time_stamp(time_stamp: TimeStamp, function_name: string, args: Array<number>) {
        this._upcoming_function_calls.push({
            function_name,
            args,
            time_stamp
        });
    }

    /// Call a function but ensure its results do not persist and cannot cause a desync.
    /// This can be used for things like drawing or querying from the Wasm
    async call_and_revert(function_name: string, args: Array<number>) {
        const f = this.wasm_instance?.instance.exports[function_name];

        if (f) {
            const snapshot = this._get_wasm_snapshot();
            (f as CallableFunction)(...args);
            this._apply_snapshot(snapshot);
        }
    }

    hash(): Uint8Array {
        const data_to_hash = new Uint8Array((this.wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer);
        return this.rust_utilities.hash_data(data_to_hash);
    }
}

export function arrayEquals(a: Uint8Array, b: Uint8Array) {
    if (a.length != b.length) {
        return false;
    }

    for (let i = 0; i < a.length; i++) {
        if (a[i] != b[i]) {
            return false;
        }
    }
    return true;
}