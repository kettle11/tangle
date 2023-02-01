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
    // hash_before: Uint8Array
};

type Grow = {
    action_type: WasmActionType.Grow,
    old_page_count: number,
    // hash_before: Uint8Array
};

type GlobalSet = {
    action_type: WasmActionType.GlobalSet,
    global_id: string,
    old_value: any,
};

type WasmSnapShot = {
    memory: Uint8Array,
    // The index in the exports and the value to set the export to
    globals: Array<[number, number]>,
}

type WasmAction = Store | Grow | GlobalSet;

export enum RollbackStrategy {
    WasmSnapshots,
    Granular,
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
    actions_caused: number,
    time_stamp: TimeStamp,
    // Used if the 'WasmSnapshot' RollBackStrategy is used.
    wasm_snapshot_before?: WasmSnapShot
};

type UpcomingFunctionCall = {
    function_name: string,
    args: Array<number>,
    time_stamp: TimeStamp,
}

export class OfflineWarpCore {
    /// The Wasm code used by WarpCore itself.
    static _warpcore_wasm?: WebAssembly.WebAssemblyInstantiatedSource;
    /// The user Wasm that WarpCore is syncing 
    wasm_instance?: WebAssembly.WebAssemblyInstantiatedSource = undefined;
    current_time: number = 0;
    private _recurring_call_interval: number = 0;
    recurring_call_time: number = 0;
    private _recurring_call_name?: string = "fixed_update";
    private _actions: Array<WasmAction> = [];
    function_calls: Array<FunctionCall> = [];
    private _imports: WebAssembly.Imports = {};

    private _rollback_strategy: RollbackStrategy = RollbackStrategy.Granular;
    private _upcoming_function_calls: Array<UpcomingFunctionCall> = new Array();

    // Optionally track hashes after each function call
    hash_tracking: boolean = true;

    static async setup(wasm_binary: Uint8Array, imports: WebAssembly.Imports, recurring_call_interval: number, rollback_strategy?: RollbackStrategy): Promise<OfflineWarpCore> {
        let decoder = new TextDecoder();

        let imports_warp_core_wasm: WebAssembly.Imports = {
            env: {
                external_log: function (pointer: number, length: number) {
                    let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
                    const message_data = new Uint8Array(memory.buffer, pointer, length);
                    const decoded_string = decoder.decode(new Uint8Array(message_data));
                    console.log(decoded_string);
                },
                external_error: function (pointer: number, length: number) {
                    let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
                    const message_data = new Uint8Array(memory.buffer, pointer, length);
                    const decoded_string = decoder.decode(new Uint8Array(message_data));
                    console.error(decoded_string);
                }
            }
        };

        OfflineWarpCore._warpcore_wasm ??= await WebAssembly.instantiateStreaming(fetch("warpcore_mvp.wasm"), imports_warp_core_wasm);

        if (!rollback_strategy) {
            // TODO: Check initial memory size and choose a rollback strategy based on that.
            rollback_strategy = RollbackStrategy.WasmSnapshots;
        }

        let warpcore = new OfflineWarpCore();
        warpcore._rollback_strategy = rollback_strategy;
        warpcore._recurring_call_interval = recurring_call_interval;
        warpcore._imports = imports;

        wasm_binary = await process_binary(wasm_binary, true, rollback_strategy == RollbackStrategy.Granular);

        if (rollback_strategy == RollbackStrategy.Granular) {

            warpcore._imports.wasm_guardian = {
                on_store: (location: number, size: number) => {
                    // console.log("HASH BEFORE STORE: ", warpcore.hash());

                    //  console.log("on_store called: ", location, size);
                    if ((location + size) > (warpcore.wasm_instance!.instance.exports.memory as WebAssembly.Memory).buffer.byteLength) {
                        console.log("OUT OF BOUNDS MEMORY SIZE IN PAGES: ", (location + size) / WASM_PAGE_SIZE);
                        console.error("MEMORY OUT OF BOUNDS!: ", location + size);
                    } else {
                        let memory = warpcore.wasm_instance!.instance.exports.memory as WebAssembly.Memory;
                        let old_value = new Uint8Array(new Uint8Array(memory.buffer, location, size));
                        warpcore._actions.push({ action_type: WasmActionType.Store, location: location, old_value: old_value, /* hash_before: warpcore.hash() */ });
                    }
                },
                on_grow: (pages: number) => {
                    console.log("on_grow called: ", pages);
                    let memory = warpcore.wasm_instance!.instance.exports.memory as WebAssembly.Memory;
                    console.log("NEW MEMORY SIZE IN PAGES: ", (memory.buffer.byteLength / WASM_PAGE_SIZE) + 1);

                    warpcore._actions.push({ action_type: WasmActionType.Grow, old_page_count: memory.buffer.byteLength / WASM_PAGE_SIZE, /* hash_before: warpcore.hash() */ });
                },
                on_global_set: (id: number) => {
                    //  console.log("on_global_set called: ", id);
                    let global_id = "wg_global_" + id;
                    warpcore._actions.push({ action_type: WasmActionType.GlobalSet, global_id: global_id, old_value: warpcore.wasm_instance?.instance.exports[global_id] });
                },
            };
        }
        let wasm_instance = await WebAssembly.instantiate(wasm_binary, warpcore._imports);

        console.log("HEAP SIZE: ", (wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer.byteLength);
        warpcore.wasm_instance = wasm_instance;

        return warpcore;
    }

    async assign_memory(new_memory_data: Uint8Array) {
        let mem = this.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
        let page_diff = (new_memory_data.byteLength - mem.buffer.byteLength) / WASM_PAGE_SIZE;

        // The only way to "shrink" a Wasm instance is to construct an entirely new 
        // one with a new memory.
        // Hopefully Wasm gets a better way to shrink modules in the future.

        if (page_diff < 0) {
            let old_instance = this.wasm_instance!.instance;
            this.wasm_instance!.instance = await WebAssembly.instantiate(this.wasm_instance!.module, this._imports);
            page_diff = (new_memory_data.byteLength - (this.wasm_instance?.instance.exports.memory as WebAssembly.Memory).buffer.byteLength) / WASM_PAGE_SIZE;

            // Copy over all globals during the resize.
            for (const [key, v] of Object.entries(old_instance.exports)) {
                if (key.slice(0, 3) == "wg_") {
                    (this.wasm_instance!.instance.exports[key] as WebAssembly.Global).value = v;
                }
            }

            // Todo: Copy Wasm tables as well.
        }

        let old_memory = this.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
        if (page_diff > 0) {
            old_memory.grow(page_diff);
        }
        new Uint8Array(old_memory.buffer).set(new_memory_data);
    }

    async reset_with_new_program(wasm_binary: Uint8Array, current_time: number,) {
        console.log("RESETTING WITH NEW PROGRAM-----------");

        wasm_binary = await process_binary(wasm_binary, true, this._rollback_strategy == RollbackStrategy.Granular);

        this.wasm_instance = await WebAssembly.instantiate(wasm_binary, this._imports);
        console.log("BINARY HASH: ", this.hash_data(wasm_binary));

        this._actions = [];
        this.function_calls = [];

        // TODO: It might be better to not reset time here.
        this.current_time = current_time;
        this.recurring_call_time = 0;
    }

    /// Restarts the WarpCore with a new memory.
    async reset_with_wasm_memory(new_memory_data: Uint8Array, new_globals_data: Map<number, number>, current_time: number, recurring_call_time: number) {
        this.assign_memory(new_memory_data);

        let exports = this.wasm_instance!.instance.exports;

        for (const [key, value] of new_globals_data) {
            (exports[`wg_global_${key}`] as WebAssembly.Global).value = value;
        }

        this._actions = [];
        this.function_calls = [];

        this.current_time = current_time;
        this.recurring_call_time = recurring_call_time;
    }

    remove_history_before(time: number) {
        // TODO: More carefully audit this function for correctness.

        let to_remove = 0;

        let i = 0;
        for (i = 0; i < this.function_calls.length; i++) {
            let f = this.function_calls[i];
            if (f.time_stamp.time < time) {
                to_remove += f.actions_caused;
            } else {
                break;
            }
        }

        // Remove all actions that occurred before this.
        this._actions.splice(0, to_remove);

        // Always leave one function call for debugging purposes.
        this.function_calls.splice(0, i - 1);
        //console.log("ACTIONS: ", this._actions);
    }


    private async _revert_actions(actions_to_remove: number) {
        let memory = this.wasm_instance?.instance.exports.memory as WebAssembly.Memory;

        let to_rollback = this._actions.splice(this._actions.length - actions_to_remove, actions_to_remove);
        for (let i = to_rollback.length - 1; i >= 0; i--) {
            let action = to_rollback[i];
            switch (action.action_type) {
                case WasmActionType.Store: {
                    let destination = new Uint8Array(memory.buffer, action.location, action.old_value.byteLength);
                    destination.set(action.old_value);


                    // let hash = this.hash();
                    // if (!arrayEquals(hash, action.hash_before)) {
                    //     console.error("ACTION HASH DOES NOT MATCH");
                    // }

                    break;
                }
                case WasmActionType.Grow: {
                    console.log("ROLLING BACK GROW!");

                    await this.assign_memory(new Uint8Array(memory.buffer, 0, action.old_page_count * WASM_PAGE_SIZE));
                    memory = this.wasm_instance!.instance.exports.memory as WebAssembly.Memory;

                    // let hash = this.hash();
                    // if (!arrayEquals(hash, action.hash_before)) {
                    //     console.error("GROW ACTION HASH DOES NOT MATCH");
                    // }

                    break;
                }
                case WasmActionType.GlobalSet: {
                    (this.wasm_instance?.instance.exports[action.global_id] as WebAssembly.Global).value = action.old_value;
                    break;
                }
            }
        }
    }

    steps_remaining(time_to_progress: number): number {
        return (((this.current_time + time_to_progress) - this.recurring_call_time) / this._recurring_call_interval);
    }

    async progress_time(time_progressed: number) {
        // time_progressed is repurposed as a resimulation budget.
        this.current_time += time_progressed;

        // Add recurring function calls
        if (this._recurring_call_name && this._recurring_call_interval > 0) {
            while ((this.current_time - this.recurring_call_time) > this._recurring_call_interval) {
                this.recurring_call_time += this._recurring_call_interval;

                let time_stamp = {
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
        let start_time = performance.now();

        while (this._upcoming_function_calls[0] && Math.sign(this._upcoming_function_calls[0].time_stamp.time - this.current_time) == -1) {
            let function_call = this._upcoming_function_calls.shift()!;

            //  console.log("CALLING %s", function_call.function_name, function_call.time_stamp);

            await this._call_inner(function_call.function_name, function_call.time_stamp, function_call!.args);

            let time_now = performance.now();
            if ((start_time - time_now) > (time_progressed * 0.75)) {
                console.log("[warpcore] Bailing out of simulation to avoid missed frames")
                break;
            }
        }
    }

    private async _apply_snapshot(wasm_snapshot_before: WasmSnapShot) {
        if (wasm_snapshot_before) {
            // Apply snapshot
            this.assign_memory(wasm_snapshot_before.memory);

            let values = Object.values(this.wasm_instance!.instance.exports);

            for (let j = 0; j < wasm_snapshot_before.globals.length; j++) {
                (values[wasm_snapshot_before.globals[j][0]] as WebAssembly.Global).value = wasm_snapshot_before.globals[j][1];
            }
        }
    }

    private _get_wasm_snapshot(): WasmSnapShot {
        // This could be optimized by checking ahead of time which globals need to be synced.
        let globals = new Array();
        let j = 0;
        for (const [key, v] of Object.entries(this.wasm_instance!.instance.exports)) {
            if (key.slice(0, 3) == "wg_") {
                //  console.log("SNAP SHOT: ", [j, (v as WebAssembly.Global).value]);
                globals.push([j, (v as WebAssembly.Global).value]);
            }
            j += 1;
        }
        return {
            // This nested Uint8Array constructor creates a deep copy.
            memory: new Uint8Array(new Uint8Array((this.wasm_instance!.instance.exports.memory as WebAssembly.Memory).buffer)),
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
        let actions_to_remove = 0;
        for (; i > 0; i--) {
            // Keep going until a timestamp less than `time_stamp` is found.
            let function_call = this.function_calls[i - 1];
            if (time_stamp_compare(function_call.time_stamp, time_stamp) == -1) {

                if (this.function_calls[i]) {
                    await this._revert_actions(actions_to_remove);

                    // This will only happen if we're using the WasmSnapshot RollbackStrategy.
                    let wasm_snapshot_before = this.function_calls[i].wasm_snapshot_before;
                    if (wasm_snapshot_before) {
                        this._apply_snapshot(wasm_snapshot_before);
                    }
                    /*
                    let hash_after_revert = this.hash();

                    if (!arrayEquals(hash_after_revert, this.function_calls[i].hash_before)) {
                        console.error("HASHES DO NOT MATCH DURING REVERT");
                    }
                    */
                }
                break;
            }
            actions_to_remove += function_call.actions_caused;
        }

        let before = this._actions.length;

        let function_call = this.wasm_instance?.instance.exports[function_name] as CallableFunction;
        if (function_call) {
            let wasm_snapshot_before;
            if (this._rollback_strategy == RollbackStrategy.WasmSnapshots) {
                wasm_snapshot_before = this._get_wasm_snapshot();
            }

            function_call(...args);

            let after = this._actions.length;

            if (after - before > 0 || this._rollback_strategy == RollbackStrategy.WasmSnapshots) {
                let hash_after;

                if (this.hash_tracking) {
                    hash_after = this.hash();
                }

                this.function_calls.splice(i, 0, {
                    name: function_name,
                    args: args,
                    time_stamp: time_stamp,
                    actions_caused: after - before,
                    wasm_snapshot_before,
                    hash_after
                });
            }
        }

        // Replay any function calls that occur after this function
        for (let j = i + 1; j < this.function_calls.length; j++) {
            let f = this.function_calls[j];
            // Note: It is assumed function calls cannot be inserted with an out-of-order offset by the same peer.
            // If that were true the offset would need to be checked and potentially updated here.

            let wasm_snapshot_before;
            if (this._rollback_strategy == RollbackStrategy.WasmSnapshots) {
                wasm_snapshot_before = this._get_wasm_snapshot();
            }

            let before = this._actions.length;
            (this.wasm_instance?.instance.exports[f.name] as CallableFunction)(...f.args);

            if (this.hash_tracking) {
                f.hash_after = this.hash();
            }

            let after = this._actions.length;
            f.actions_caused = after - before;
            f.wasm_snapshot_before = wasm_snapshot_before;
        }
        return i;
    }

    /// Returns the function call of this instance.
    async call_with_time_stamp(time_stamp: TimeStamp, function_name: string, args: Array<number>) {
        // TODO: Check for a PlayerId to insert into args
        // TODO: Use a real player ID.

        this._upcoming_function_calls.push({
            function_name,
            args,
            time_stamp
        });

        /*
        let new_call_index = await this._call_inner(function_name, time_stamp, args);

        // console.log("FUNCTION CALLS: ", structuredClone(this.function_calls));
        this.time_offset += 1;
        return new_call_index;
        */
    }

    /// Call a function but ensure its results do not persist and cannot cause a desync.
    /// This can be used for things like drawing or querying from the Wasm
    async call_and_revert(function_name: string, args: Array<number>) {
        let before = this._actions.length;
        let snapshot;
        if (this._rollback_strategy == RollbackStrategy.WasmSnapshots) {
            snapshot = this._get_wasm_snapshot();
        }
        (this.wasm_instance?.instance.exports[function_name] as CallableFunction)(...args);
        if (snapshot) {
            this._apply_snapshot(snapshot);
        }
        let after = this._actions.length;
        await this._revert_actions(after - before);
    }

    // TODO: These are just helpers and aren't that related to the rest of the code in this:
    gzip_encode(data_to_compress: Uint8Array) {
        let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
        let exports = OfflineWarpCore._warpcore_wasm!.instance.exports;

        let pointer = (exports.reserve_space as CallableFunction)(data_to_compress.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_compress.byteLength);
        destination.set(new Uint8Array(data_to_compress));

        (exports.gzip_encode as CallableFunction)();
        let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        console.log("COMPRESSED LENGTH: ", result_data.byteLength);
        console.log("COMPRESSION RATIO: ", data_to_compress.byteLength / result_data.byteLength);
        return result_data;
    }

    gzip_decode(data_to_decode: Uint8Array) {
        let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
        let instance = OfflineWarpCore._warpcore_wasm!.instance.exports;

        let pointer = (instance.reserve_space as CallableFunction)(data_to_decode.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_decode.byteLength);
        destination.set(data_to_decode);

        (instance.gzip_decode as CallableFunction)();
        let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        return new Uint8Array(result_data);
    }
    hash(): Uint8Array {
        let data_to_hash = new Uint8Array((this.wasm_instance!.instance.exports.memory as WebAssembly.Memory).buffer);
        return this.hash_data(data_to_hash);
    }
    /*
    print_globals() {
        for (const [key, v] of Object.entries(this.wasm_instance!.instance.exports)) {
            if (key.slice(0, 3) == "wg_") {
                console.log("GLOBAL: ", [key, v.value]);
            }
        }
    }
    */
    hash_data(data_to_hash: Uint8Array): Uint8Array {
        let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;
        let instance = OfflineWarpCore._warpcore_wasm!.instance.exports;

        let pointer = (instance.reserve_space as CallableFunction)(data_to_hash.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_hash.byteLength);
        destination.set(new Uint8Array(data_to_hash));

        (instance.xxh3_128_bit_hash as CallableFunction)();
        let hashed_result = new Uint8Array(new Uint8Array(memory.buffer, pointer, 16));
        return hashed_result;
    }
}
/// Preprocess the binary to record all persistent state edits.
async function process_binary(wasm_binary: Uint8Array, export_globals: boolean, track_changes: boolean) {
    if (!(export_globals || track_changes)) {
        return wasm_binary;
    }

    let length = wasm_binary.byteLength;
    let pointer = (OfflineWarpCore._warpcore_wasm?.instance.exports.reserve_space as CallableFunction)(length);

    let memory = OfflineWarpCore._warpcore_wasm?.instance.exports.memory as WebAssembly.Memory;

    const data_location = new Uint8Array(memory.buffer, pointer, length);
    data_location.set(new Uint8Array(wasm_binary));
    (OfflineWarpCore._warpcore_wasm?.instance.exports.prepare_wasm as CallableFunction)(export_globals, track_changes);

    // TODO: Write these to an output buffer instead of having two calls for them.
    let output_ptr = (OfflineWarpCore._warpcore_wasm?.instance.exports.get_output_ptr as CallableFunction)();
    let output_len = (OfflineWarpCore._warpcore_wasm?.instance.exports.get_output_len as CallableFunction)();
    const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);
    return output_wasm;
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