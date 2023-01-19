const WASM_PAGE_SIZE = 65536;

enum WasmActionType {
    Store,
    Grow,
    GlobalSet
}

type Store = {
    action_type: WasmActionType.Store,
    location: number,
    old_value: Uint8Array
};

type Grow = {
    action_type: WasmActionType.Grow,
    old_page_count: number,
};

type GlobalSet = {
    action_type: WasmActionType.GlobalSet,
    global_id: string,
    old_value: any,
};

type WasmAction = Store | Grow | GlobalSet;

type TimeStamp = {
    time: number,
    offset: number,
    player_id: number,
};

function time_stamp_less_than(a: TimeStamp, b: TimeStamp): boolean {
    return a.time < b.time
        || a.player_id < b.player_id
        || a.offset < b.offset;
}

export type FunctionCall = {
    name: string,
    args: Array<number>,
    actions_length_before: number,
    time_stamp: TimeStamp
};

export class OfflineWarpCore {
    /// The Wasm code used by WarpCore itself.
    static _warpcore_wasm?: WebAssembly.WebAssemblyInstantiatedSource;
    /// The user Wasm that WarpCore is syncing 
    wasm_instance?: WebAssembly.WebAssemblyInstantiatedSource = undefined;
    current_time: number = 0;
    time_offset: number = 0;
    private _recurring_call_interval: number = 0;
    private _recurring_call_time: number = 0;
    private _recurring_call_name?: string = undefined;
    private _actions: Array<WasmAction> = [];
    function_calls: Array<FunctionCall> = [];
    private _imports: WebAssembly.Imports = {};

    static async setup(wasm_binary: Uint8Array, imports: WebAssembly.Imports): Promise<OfflineWarpCore> {
        // TODO: Support setting the recurring call interval
        OfflineWarpCore._warpcore_wasm ??= await WebAssembly.instantiateStreaming(fetch("warpcore_mvp.wasm"));

        let processed_binary = await process_binary(wasm_binary);

        let warpcore = new OfflineWarpCore();
        warpcore._imports = imports;

        warpcore._imports.wasm_guardian = {
            on_store: () => (location: number, size: number) => {
                console.log("on_store called: ", location, size);
                let memory = warpcore.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
                let old_value = new Uint8Array(new Uint8Array(memory.buffer, location, size));

                warpcore._actions.push({ action_type: WasmActionType.Store, location: location, old_value: old_value, /* hash: new Uint8Array(xxh3_128_bit_hash(wasm_memory.buffer))*/ });
            },
            on_grow: () => (pages: number) => {
                console.log("on_grow called: ", pages);
                let memory = warpcore.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
                warpcore._actions.push({ action_type: WasmActionType.Grow, old_page_count: memory.buffer.byteLength / WASM_PAGE_SIZE });
            },
            on_global_set: (id: number) => {
                console.log("on_global_set called: ", id);
                let global_id = "wg_global_" + id;
                warpcore._actions.push({ action_type: WasmActionType.GlobalSet, global_id: global_id, old_value: warpcore.wasm_instance?.instance.exports[global_id] });
            },
        };
        let wasm_instance = await WebAssembly.instantiate(processed_binary, warpcore._imports);
        warpcore.wasm_instance = wasm_instance;

        return warpcore;
    }

    /// Restarts the WarpCore with a new memory.
    async reset_with_wasm_memory(new_memory_data: Uint8Array, current_time: number, _recurring_call_time: number) {
        let pages = new_memory_data.byteLength / WASM_PAGE_SIZE;

        let new_memory = new WebAssembly.Memory({
            initial: pages
        });
        this._imports.env.mem = new_memory;

        this.wasm_instance!.instance = await WebAssembly.instantiate(this.wasm_instance!.module, this._imports);
        new Uint8Array(new_memory.buffer).set(new_memory_data);
        this._actions = [];
        this.function_calls = [];

        this.current_time = current_time;
        this._recurring_call_time = _recurring_call_time;
        this.time_offset = 0;
    }

    private async _rollback_to_length(actions_length: number) {
        let memory = this.wasm_instance?.instance.exports.memory as WebAssembly.Memory;

        let to_rollback = this._actions.splice(actions_length, this._actions.length - actions_length);
        for (let i = 0; i < to_rollback.length; i++) {
            let action = to_rollback[i];
            switch (action.action_type) {
                case WasmActionType.Store: {
                    let destination = new Uint8Array(memory.buffer, action.location, action.old_value.byteLength);
                    destination.set(action.old_value);
                    break;
                }
                case WasmActionType.Grow: {
                    // The only way to "shrink" a Wasm instance is to construct an entirely new 
                    // one with a new memory.
                    // Hopefully Wasm gets a better way to shrink modules in the future.

                    let new_memory = new WebAssembly.Memory({
                        initial: action.old_page_count
                    });

                    let dest = new Uint8Array(new_memory.buffer);
                    dest.set(new Uint8Array(memory.buffer, 0, new_memory.buffer.byteLength));

                    // TODO: Is `env` correct here?
                    this._imports.env.mem = new_memory;

                    this.wasm_instance!.instance = await WebAssembly.instantiate(this.wasm_instance!.module!, this._imports);
                    break;
                }
                case WasmActionType.GlobalSet: {
                    (this.wasm_instance?.instance.exports[action.global_id] as WebAssembly.Global).value = action.old_value;
                    break;
                }
            }
        }
    }

    async progress_time(time_progressed: number) {
        this.current_time += time_progressed;

        if (time_progressed > 0) {
            this.time_offset = 0;
        }

        // Trigger all of the recurring calls.
        // TODO: Check if recurring call interval is defined at all.
        while ((this.current_time - this._recurring_call_time) > this._recurring_call_interval) {
            this.time_offset = 0;
            this._recurring_call_time += this._recurring_call_interval;

            if (this._recurring_call_name) {
                // TODO: Real player ID.
                let time_stamp = {
                    time: this._recurring_call_time,
                    offset: 0, // A recurring call should always be the first call
                    player_id: 0
                };
                this.time_offset += 1;
                await this._call_inner(this._recurring_call_name, time_stamp, []);
            }
        }
    }

    private async _call_inner(function_name: string, time_stamp: TimeStamp, args: number[]) {
        // Rewind any function calls that occur after this.
        let i = this.function_calls.length - 1;
        for (; i >= 0; i--) {
            if (!time_stamp_less_than(this.function_calls[i].time_stamp, time_stamp)) {
                await this._rollback_to_length(this.function_calls[i].actions_length_before);
                break;
            }
        }

        let actions_length_before = this._actions.length;
        (this.wasm_instance?.instance.exports[function_name] as CallableFunction)(...args);

        this.function_calls.splice(i, 0, {
            name: function_name,
            args: args,
            actions_length_before: actions_length_before,
            time_stamp: time_stamp
        });

        // Replay any function calls that occur after this function
        for (let j = i + 1; j < this.function_calls.length; j++) {
            let f = this.function_calls[i];
            let actions_length_before = this._actions.length;
            f.actions_length_before = actions_length_before;

            // Note: It is assumed function calls cannot be inserted with an out-of-order offset by the same peer.
            // If that were true the offset would need to be checked and potentially updated here.

            (this.wasm_instance?.instance.exports[f.name] as CallableFunction)(...f.args);
        }
    }

    next_time_stamp(): TimeStamp {
        return {
            time: this.current_time,
            offset: this.time_offset,
            player_id: 0,
        };
    }

    async call_with_time_stamp(time_stamp: TimeStamp, function_name: string, args: [number]) {
        // TODO: Check for a PlayerId to insert into args
        // TODO: Use a real player ID.
        await this._call_inner(function_name, time_stamp, args);
        this.time_offset += 1;
    }

    /// Call a function but ensure its results do not persist and cannot cause a desync.
    /// This can be used for things like drawing or querying from the Wasm
    async call_and_revert(function_name: string, args: [number]) {
        let actions_length = this._actions.length;
        (this.wasm_instance?.instance.exports[function_name] as CallableFunction)(...args);
        this._rollback_to_length(actions_length);
    }


    // TODO: These are just helpers and aren't that related to the rest of the code in this:
    gzip_encode(data_to_compress: Uint8Array) {
        let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
        let instance = this.wasm_instance!.instance.exports;

        let pointer = (instance.reserve_space as CallableFunction)(data_to_compress.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_compress.byteLength);
        destination.set(new Uint8Array(data_to_compress));

        (instance.gzip_encode as CallableFunction)();
        let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        console.log("COMPRESSED LENGTH: ", result_data.byteLength);
        console.log("COMPRESSION RATIO: ", data_to_compress.byteLength / result_data.byteLength);
        return result_data;
    }

    gzip_decode(data_to_decode: Uint8Array) {
        let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
        let instance = this.wasm_instance!.instance.exports;

        let pointer = (instance.reserve_space as CallableFunction)(data_to_decode.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_decode.byteLength);
        destination.set(new Uint8Array(data_to_decode));

        (instance.gzip_decode as CallableFunction)();
        let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        return result_data;
    }
}
/// Preprocess the binary to record all persistent state edits.
async function process_binary(wasm_binary: Uint8Array) {
    let length = wasm_binary.byteLength;
    let pointer = (OfflineWarpCore._warpcore_wasm?.instance.exports.reserve_space as CallableFunction)(length);

    let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;

    const data_location = new Uint8Array(memory.buffer, pointer, length);
    data_location.set(new Uint8Array(wasm_binary));
    (OfflineWarpCore._warpcore_wasm?.instance.exports.prepare_wasm as CallableFunction)();

    // TODO: Write these to an output buffer instead of having two calls for them.
    let output_ptr = (OfflineWarpCore._warpcore_wasm?.instance.exports.get_output_ptr as CallableFunction)();
    let output_len = (OfflineWarpCore._warpcore_wasm?.instance.exports.get_output_len as CallableFunction)();
    const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);
    return output_wasm;
}