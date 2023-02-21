import { MessageWriterReader } from "./message_encoding";
import { RustUtilities } from "./rust_utilities";

const WASM_PAGE_SIZE = 65536;

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
    //name: string,
    function_export_index: number,
    args: Array<number>,
    time_stamp: TimeStamp,
    hash?: Uint8Array
};

export type WasmSnapshot = {
    memory: Uint8Array,
    // The index in the exports and the value to set the export to
    globals: Array<[number, unknown]>,
    time_stamp: TimeStamp
}

type Event = FunctionCall;
const decoder = new TextDecoder();

// Used for debugging
let action_log = "";
const debug_mode = false;

export class TimeMachine {
    _fixed_update_interval?: number;

    private _current_simulation_time: TimeStamp = { time: 0, player_id: 0 };
    private _fixed_update_time = 0;
    private _target_time = 0;

    private _need_to_rollback_to_time?: TimeStamp;

    private _events: Array<Event> = [];
    private _snapshots: Array<WasmSnapshot> = [];

    _wasm_instance: WebAssembly.WebAssemblyInstantiatedSource;
    private _imports: WebAssembly.Imports = {};

    private _global_indices: Array<number> = [];
    private _exports: Array<WebAssembly.ExportValue> = [];
    private _export_keys: Array<string> = [];

    // To facilitate simpler storage, serialization, and networking function calls
    // are associated with an index instead of a string.
    private _function_name_to_index: Map<string, number> = new Map();
    private _fixed_update_index: number | undefined;

    rust_utilities: RustUtilities

    private constructor(wasm_instance: WebAssembly.WebAssemblyInstantiatedSource, rust_utilities: RustUtilities) {
        this._wasm_instance = wasm_instance;
        this._exports = Object.values(wasm_instance.instance.exports);
        this._export_keys = Object.keys(wasm_instance.instance.exports);
        this.rust_utilities = rust_utilities;
    }

    static async setup(wasm_binary: Uint8Array, imports: WebAssembly.Imports, fixed_update_interval?: number): Promise<TimeMachine> {
        const rust_utilities = await RustUtilities.setup();

        // TODO: These imports are for AssemblyScript, but they should be optional
        // or part of a more fleshed-out strategy for how to manage imports.
        {
            imports.env ??= {};

            imports.env.abort ??= () => {
                console.log("Ignoring call to abort");
            };
            imports.env.seed ??= () => {
                // TODO: Add more entropy
                return 14;
            };
        }

        imports.wasm_guardian = {};
        imports.wasm_guardian.on_grow = (amount: number) => {
            /*
            const dirty_flags = time_machine._wasm_instance.instance.exports["wg_dirty_flags"] as WebAssembly.Table;
            dirty_flags.grow(amount);
            console.log("ON GROW: ", time_machine._wasm_instance.instance.exports["wg_dirty_flags"]);
            */

        };
        imports.wasm_guardian.on_global_set = () => {
            // console.log("ON GLOBAL SET");
        };
        let external_log: (a: number, b: number) => void = () => { console.log("Not implemented") };
        imports.env.external_log ??= (a: number, b: number) => external_log(a, b);

        wasm_binary = rust_utilities.process_binary(wasm_binary, true, true);
        const wasm_instance = await WebAssembly.instantiate(wasm_binary, imports);

        const time_machine = new TimeMachine(wasm_instance, rust_utilities);

        console.log("[tangle] Heap size: ", (wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer.byteLength);

        // TODO: Think more about what 'standard library' Wasm should be provided.
        external_log = (pointer: number, length: number) => {
            const memory = time_machine._wasm_instance.instance.exports.memory as WebAssembly.Memory;
            const message_data = new Uint8Array(memory.buffer, pointer, length);
            const decoded_string = decoder.decode(new Uint8Array(message_data));
            console.log(decoded_string);
        };

        // When a module is setup call its main function immediately.
        // This may only be useful for Rust.
        {
            const main = wasm_instance.instance.exports["main"];
            if (main) {
                (main as CallableFunction)();
            }
        }

        time_machine._imports = imports;
        time_machine._fixed_update_interval = fixed_update_interval;

        let j = 0;
        for (const key of Object.keys(wasm_instance.instance.exports)) {
            if (key.slice(0, 3) == "wg_") {
                time_machine._global_indices.push(j);
            }

            time_machine._function_name_to_index.set(key, j);
            if (key == "fixed_update") {
                time_machine._fixed_update_index = j;
            }
            j += 1;
        }

        // Default to 60 frame-per second if unspecified.
        // If there's no "fixed_update" function do not generate 'fixed_update' calls.
        if (time_machine._fixed_update_index !== undefined) {
            time_machine._fixed_update_interval ??= 1000 / 60;
        } else {
            time_machine._fixed_update_interval = undefined;
        }

        // This ensures the first message is slightly into the future.

        time_machine._snapshots = [time_machine._get_wasm_snapshot()];

        if (time_machine._wasm_instance.instance.exports.allocate_dirty_flags_array) {
            const dirty_flags_size = 20;
            const dirty_flags_array_pointer = (time_machine._wasm_instance.instance.exports.allocate_dirty_flags_array as CallableFunction)(dirty_flags_size);
            (time_machine._wasm_instance.instance.exports.wg_dirty_flags as WebAssembly.Global).value = dirty_flags_array_pointer;
            time_machine.dirty_flags_array = new Uint8Array((time_machine._wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer, dirty_flags_array_pointer, dirty_flags_size);
        }
        console.log("🚀⏳ Time Machine Activated ⏳🚀");
        return time_machine;
    }

    read_memory(address: number, length: number): Uint8Array {
        return new Uint8Array(new Uint8Array((this._wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer, address, length));
    }

    read_string(address: number, length: number): string {
        const message_data = this.read_memory(address, length);
        const decoded_string = decoder.decode(new Uint8Array(message_data));
        return decoded_string;
    }

    get_function_export_index(function_name: string): number | undefined {
        return this._function_name_to_index.get(function_name);
    }

    get_function_name(function_index: number): string | undefined {
        return this._export_keys[function_index];
    }

    /// Returns the function call of this instance.
    async call_with_time_stamp(function_export_index: number, args: Array<number>, time_stamp: TimeStamp) {
        if (time_stamp_compare(time_stamp, this._snapshots[0].time_stamp) == -1) {
            // TODO: This is an error. It's no longer possible to add events in the past.
            // Report a desync here.
            console.error("[tangle error] Attempting to rollback to before earliest safe time");
            console.error("Event Time: ", time_stamp);
            console.error("Earlieset Snapshot Time: ", this._snapshots[0].time_stamp);
            throw new Error("[tangle error] Attempting to rollback to before earliest safe time");
        }

        // To avoid excessive reordering insert recurring function calls that
        // will occur before this function call.
        this._progress_recurring_function_calls(time_stamp.time);

        let i = this._events.length - 1;
        outer_loop:
        for (; i >= 0; i -= 1) {
            switch (time_stamp_compare(this._events[i].time_stamp, time_stamp)) {
                case -1:
                    // This is where we should insert.
                    break outer_loop;
                case 1:
                    break;
                case 0: {
                    const event = this._events[i];
                    if (function_export_index != event.function_export_index || !(array_equals(args, event.args))) {
                        // This shouldn't happen, but if it does we can safely ignore it and move on.
                        console.error("[tangle warning] Attempted to call a function with a duplicate time stamp.");
                        console.log("Event Time: ", time_stamp);
                        console.log("Function name: ", this.get_function_name(function_export_index));
                    }
                    // If this event is a duplicate but is exactly the same as an existing event we can safely ignore it.
                    return;
                }
            }
        }

        if (time_stamp_compare(time_stamp, this._current_simulation_time) == -1) {
            // Make sure to rollback to the furthest point in the past that's required. 
            if (this._need_to_rollback_to_time === undefined || time_stamp_compare(time_stamp, this._need_to_rollback_to_time) == -1) {
                // This will cause a rollback next time `simulate_forward` is called.
                this._need_to_rollback_to_time = time_stamp;
            }
        }

        const event = {
            function_export_index,
            args,
            time_stamp,
        };
        // Insert after the found insertion point.
        this._events.splice(i + 1, 0, event);

        if (debug_mode) {
            action_log += `Inserting call ${i + 1} ${event.time_stamp.time} ${event.time_stamp.player_id} ${this.get_function_name(event.function_export_index)}\n`
        }
    }

    /// Call a function but ensure its results do not persist and cannot cause a desync.
    /// This can be used for things like drawing or querying from the Wasm
    async call_and_revert(function_export_index: number, args: Array<number>) {
        const f = this._exports[function_export_index] as CallableFunction;

        if (f) {
            const snapshot = this._get_wasm_snapshot();
            (f as CallableFunction)(...args);
            await this._apply_snapshot(snapshot);
        }
    }

    private _progress_recurring_function_calls(target_time: number) {
        if (this._fixed_update_interval !== undefined && this._fixed_update_index !== undefined) {
            // Add `fixed_update` calls that go into the future.
            while (target_time > this._fixed_update_time) {
                this.call_with_time_stamp(this._fixed_update_index, [], { time: this._fixed_update_time, player_id: 0 });
                this._fixed_update_time += this._fixed_update_interval;
            }
        }
    }

    target_time(): number {
        return this._target_time;
    }

    // This is used in scenarios where a peer falls too far behind in a simulation. 
    // This lets them have normal visuals until they resync.
    set_target_time(time: number) {
        this._target_time = time;
    }

    current_simulation_time(): number {
        return this._current_simulation_time.time;
    }

    /// This lets the simulation run further into the future.
    /// No functions are actually called yet, that's the responsibility of `step`
    progress_time(time: number) {
        this._target_time += time;
        this._progress_recurring_function_calls(this._target_time);
    }

    /// Simulates one function step forward and returns if there's more work to do.
    /// This gives the calling context an opportunity to manage how much CPU-time is consumed.
    /// Call this is in a loop and if it returns true continue. 
    step(): boolean {
        if (this._need_to_rollback_to_time !== undefined) {
            // Perform a rollback here.

            if (debug_mode) {
                action_log += `Target rollback time: ${this._need_to_rollback_to_time.time} ${this._need_to_rollback_to_time.player_id}\n`;
            }
            // Apply the most recent snapshot.
            let i = this._snapshots.length - 1;
            for (; i >= 0; --i) {
                if (time_stamp_compare(this._need_to_rollback_to_time, this._snapshots[i].time_stamp) != -1) {
                    break;
                }
            }

            const snap_shot = this._snapshots[i];
            this._apply_snapshot(snap_shot);

            // Remove future snapshots
            this._snapshots.splice(i, this._snapshots.length - i);

            if (debug_mode) {
                action_log += `Rolling back to: ${snap_shot.time_stamp.time} ${snap_shot.time_stamp.player_id}\n`;
            }

            // Begin simulation from the event that occurred after the snapshot rolled back to.
            this._current_simulation_time = snap_shot.time_stamp;
            this._need_to_rollback_to_time = undefined;
        }

        let i = this._events.length - 1;
        for (; i >= 0; --i) {
            if (time_stamp_compare(this._events[i].time_stamp, this._current_simulation_time) != 1) {
                break;
            }
        }
        i += 1;

        const function_call = this._events[i];
        if (function_call !== undefined && function_call.time_stamp.time <= this._target_time) {
            const f = this._exports[function_call.function_export_index] as CallableFunction;

            const now = performance.now();
            f(...function_call.args);
            if (this.get_function_name(function_call.function_export_index) == "fixed_update") {
                console.log("TIME: ", performance.now() - now);
            }

            if (debug_mode) {
                function_call.hash = this.hash_wasm_state();
            }

            if (action_log) {
                const event = function_call;
                action_log += `i ${event.time_stamp.time} ${event.time_stamp.player_id} ${this.get_function_name(event.function_export_index)} ${event.hash}\n`
            }

            this._current_simulation_time = function_call.time_stamp;
            return true;
        }
        return false;
    }

    // Take a snapshot. This provides a point in time to rollback to.
    // This should be called after significant computation has been performed.
    take_snapshot() {
        let i = this._events.length - 1;
        for (; i >= 0; --i) {
            const compare = time_stamp_compare(this._events[i].time_stamp, this._current_simulation_time);
            if (compare == -1) {
                return;
            }
            if (compare == 0) {
                this._snapshots.push(this._get_wasm_snapshot());
                // There is no need to store the function anymore after this, so remove it from the events array.
                return;
            }
        }
    }

    remove_history_before(time: number) {
        if (debug_mode) {
            return;
        }

        // Remove all events and snapshots that occurred before this time.
        // Progress the safe time. 
        // Always leave at least one snapshot to rollback to.

        let i = 0;
        // To ensure there's always atleast one snapshot to rollback to:
        // this._snapshots.length - 1 
        for (; i < this._snapshots.length - 1; ++i) {
            if (this._snapshots[i].time_stamp.time >= time) {
                break;
            }
        }
        i -= 1;
        this._snapshots.splice(0, i);

        // Remove all events that occurred before the latest snapshot.
        let j = 0;
        for (; j < this._events.length; ++j) {
            if (time_stamp_compare(this._events[j].time_stamp, this._snapshots[0].time_stamp) != -1) {
                break;
            }
        }
        j -= 1;
        this._events.splice(0, j);
    }

    // `deep` specifies if the memory is deep-copied for this snapshot. 
    private _get_wasm_snapshot(deep = true): WasmSnapshot {
        const globals: Array<[number, unknown]> = [];

        const export_values = Object.values(this._wasm_instance.instance.exports);
        for (const index of this._global_indices) {
            globals.push([index, (export_values[index] as WebAssembly.Global).value]);
        }

        let memory = new Uint8Array((this._wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer);
        if (deep) {
            memory = new Uint8Array(memory);
        }

        // console.log("TOTAL SIZE: ", this._snapshots.length * memory.byteLength);

        return {
            // This nested Uint8Array constructor creates a deep copy.
            memory,
            globals,
            time_stamp: this._current_simulation_time
        };
    }

    private async _apply_snapshot(snapshot: WasmSnapshot) {
        this._assign_memory(snapshot.memory);

        const values = Object.values(this._wasm_instance.instance.exports);

        for (let j = 0; j < snapshot.globals.length; j++) {
            (values[snapshot.globals[j][0]] as WebAssembly.Global).value = snapshot.globals[j][1];
        }
    }

    private async _assign_memory(new_memory_data: Uint8Array) {
        const mem = this._wasm_instance?.instance.exports.memory as WebAssembly.Memory;
        let page_diff = (new_memory_data.byteLength - mem.buffer.byteLength) / WASM_PAGE_SIZE;

        // The only way to "shrink" a Wasm instance is to construct an entirely new 
        // one with a new memory.
        // Hopefully Wasm gets a better way to shrink instances in the future.

        if (page_diff < 0) {
            const old_instance = this._wasm_instance.instance;
            this._wasm_instance.instance = await WebAssembly.instantiate(this._wasm_instance.module, this._imports);
            page_diff = (new_memory_data.byteLength - (this._wasm_instance?.instance.exports.memory as WebAssembly.Memory).buffer.byteLength) / WASM_PAGE_SIZE;

            // Copy over all globals during the resize.
            for (const [key, v] of Object.entries(old_instance.exports)) {
                if (key.slice(0, 3) == "wg_") {
                    (this._wasm_instance.instance.exports[key] as WebAssembly.Global).value = v;
                }
            }

            // TODO: Copy mutable Wasm tables as well.
        }

        const old_memory = this._wasm_instance?.instance.exports.memory as WebAssembly.Memory;
        if (page_diff > 0) {
            old_memory.grow(page_diff);
        }
        new Uint8Array(old_memory.buffer).set(new_memory_data);
    }

    encode(first_byte: number): Uint8Array {
        console.log("[time-machine] Encoding with hash: ", this.hash_wasm_state());

        // For bandwidth / performance reasons only send encode
        // the earliest safe snapshot and all subsequent events.
        // It's up to the decoding TimeMachine to catchup.
        const snapshot = this._snapshots[0];

        let size = 1 + 8 * 4 + 4 + (4 + 8 + 8 + 1) * this._events.length;
        for (const event of this._events) {
            size += event.args.length * 8;
        }
        size += 8 + 8 + 2 + (4 + 9) * snapshot.globals.length;
        size += 4 + snapshot.memory.buffer.byteLength;

        const writer = new MessageWriterReader(new Uint8Array(size));

        writer.write_u8(first_byte);

        // Encode _earliest_safe_time
        // Encode _fixed_update_time
        // Encode _target_time
        // Encode _next_run_event_index
        // Encode _events
        // Encode _snapshot

        writer.write_f64(this._fixed_update_time);
        writer.write_f64(this._target_time);
        writer.write_time_stamp(snapshot.time_stamp);

        // Encode events
        writer.write_u32(this._events.length);
        for (const event of this._events) {
            writer.write_u32(event.function_export_index);
            writer.write_time_stamp(event.time_stamp);
            writer.write_u8(event.args.length);
            for (const arg of event.args) {
                writer.write_f64(arg);
            }
        }

        // Encode the snapshot
        writer.write_wasm_snapshot(snapshot);

        // Debugging
        console.log("[time-machine] Hash of sent snapshot: ", this.rust_utilities.hash_snapshot(snapshot));

        return writer.get_result_array();
    }

    decode_and_apply(reader: MessageWriterReader) {
        this._fixed_update_time = reader.read_f64();
        this._target_time = reader.read_f64();
        this._current_simulation_time = reader.read_time_stamp();

        const events_length = reader.read_u32();
        this._events = new Array(events_length);

        let last_time_stamp = {
            time: -1,
            player_id: 0,
        };
        for (let i = 0; i < events_length; ++i) {
            const function_export_index = reader.read_u32();
            const time_stamp = reader.read_time_stamp();

            const args_length = reader.read_u8();
            const args = new Array(args_length);
            for (let j = 0; j < args_length; ++j) {
                args[j] = reader.read_f64();
            }
            this._events[i] = {
                function_export_index,
                time_stamp,
                args,
            };

            if (!(time_stamp_compare(last_time_stamp, time_stamp) == -1)) {
                console.error("[time-machine] Error: Incoming time stamps out of order");
            }
            last_time_stamp = time_stamp;
        }

        const wasm_snapshot = reader.read_wasm_snapshot();

        // Evaluate if WasmSnapshot really needs to have a TimeStamp.
        this._apply_snapshot(wasm_snapshot);
        this._snapshots = [wasm_snapshot];

        console.log("[time-machine] Decoded with hash: ", this.hash_wasm_state());
    }

    hash_wasm_state(): Uint8Array {
        return this.rust_utilities.hash_snapshot(this._get_wasm_snapshot(false));
    }

    print_history() {
        let history = "";
        let previous_time_stamp = { time: -1, player_id: 0 };
        for (const event of this._events) {
            if (time_stamp_compare(previous_time_stamp, event.time_stamp) != -1) {
                history += "ERROR: OUT OF ORDER TIMESTAMPS\n";
            }
            history += `${event.time_stamp.time} ${event.time_stamp.player_id} ${this.get_function_name(event.function_export_index)} ${event.hash}\n`
            previous_time_stamp = event.time_stamp;
        }
        console.log(action_log);
        console.log(history);
    }

}

function array_equals(a: number[], b: number[]) {
    return a.length === b.length &&
        a.every((val, index) => val === b[index]);
}
