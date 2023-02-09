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
};

export type WasmSnapshot = {
    memory: Uint8Array,
    // The index in the exports and the value to set the export to
    globals: Array<[number, unknown]>,
    time_stamp: TimeStamp
}

type Event = FunctionCall;
const decoder = new TextDecoder();

export class TimeMachine {
    _fixed_update_interval?: number;

    // The earliest recordered time that it's safe to rollback to.
    private _earliest_safe_time = 0;
    private _fixed_update_time = 0;
    private _target_time = 0;

    private _next_run_event_index = 0;
    private _need_to_rollback_to_index?: number;

    private _events: Array<Event> = [];
    private _snapshots: Array<WasmSnapshot> = [];

    private _wasm_instance: WebAssembly.WebAssemblyInstantiatedSource;
    private _imports: WebAssembly.Imports = {};

    private _global_indices: Array<number> = [];
    private _exports: Array<WebAssembly.ExportValue> = [];

    // To facilitate simpler storage, serialization, and networking function calls
    // are associated with an index instead of a string.
    private _function_name_to_index: Map<string, number> = new Map();
    private _fixed_update_index: number | undefined;

    rust_utilities: RustUtilities

    private constructor(wasm_instance: WebAssembly.WebAssemblyInstantiatedSource, rust_utilities: RustUtilities) {
        this._wasm_instance = wasm_instance;
        this._exports = Object.values(wasm_instance.instance.exports);
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
        let external_log: (a: number, b: number) => void = () => { console.log("Not implemented") };
        imports.env.external_log ??= (a: number, b: number) => external_log(a, b);


        wasm_binary = rust_utilities.process_binary(wasm_binary, true, false);
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

        // If there's no "fixed_update" function change behavior to account for that.
        if (!time_machine._fixed_update_index) {
            time_machine._fixed_update_interval = undefined;
        }

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

    /// Returns the function call of this instance.
    async call_with_time_stamp(function_export_index: number, args: Array<number>, time_stamp: TimeStamp) {
        // TODO:
        // LEFT OFF HERE:
        // This goes to -1 which is incorrect.

        let i = this._events.length - 1;
        outer_loop:
        for (; i >= 0; i -= 1) {
            switch (time_stamp_compare(this._events[i].time_stamp, time_stamp)) {
                case -1:
                    // This is where we should insert.
                    break outer_loop;
                case 1:
                    break;
                case 0:
                    // TODO: This is an error! There should not be duplicate time-stamped events.
                    // Report a desync here.
                    console.error("[tangle error] Attempted to call a function with a duplicate time stamp.");

                    break;
            }
        }
        i += 1;

        // To avoid excessive reordering insert recurring function calls that
        // will occur before this function call.
        this._progress_recurring_function_calls(time_stamp.time);

        if (time_stamp.time < this._earliest_safe_time) {
            // TODO: This is an error. It's no longer possible to add events in the past.
            // Report a desync here.
            console.error("[tangle error] Attempting to rollback to before earliest safe time");
        }

        if (i < this._next_run_event_index) {
            // This will cause a rollback next time `simulate_forward` is called.
            this._need_to_rollback_to_index = i;
            this._next_run_event_index = i;
        }

        this._events.splice(i, 0, {
            function_export_index,
            args,
            time_stamp
        });
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
        if (this._fixed_update_interval && this._fixed_update_index) {
            // Add `fixed_update` calls that go into the future.
            while ((target_time - this._fixed_update_time) >= this._fixed_update_interval) {
                this.call_with_time_stamp(this._fixed_update_index, [], { time: this._fixed_update_time, player_id: 0 });
                this._fixed_update_time += this._fixed_update_interval;
            }
        }
    }

    target_time(): number {
        return this._target_time;
    }

    current_simulation_time(): number {
        let current_simulation_time = this._earliest_safe_time;
        if (this._next_run_event_index > 0) {
            current_simulation_time = this._events[this._next_run_event_index - 1].time_stamp.time;
        }
        return current_simulation_time;
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
        if (this._need_to_rollback_to_index) {
            const time_stamp = this._events[this._need_to_rollback_to_index].time_stamp;

            // Perform a rollback here.

            // Apply the most recent snapshot.
            let i = this._snapshots.length - 1;
            for (; i >= 0; --i) {
                if (time_stamp_compare(time_stamp, this._snapshots[i].time_stamp) != 1) {
                    break;
                }
            }
            const snap_shot = this._snapshots[i];
            this._apply_snapshot(snap_shot);
            // Remove future snapshots
            this._snapshots.splice(i, this._snapshots.length - i);

            // Reapply events between this snapshot and the rollback point.
            i = this._events.length;
            for (; i >= 0; --i) {
                if (time_stamp_compare(this._events[i].time_stamp, snap_shot.time_stamp) != 1) {
                    i += 1;
                    break;
                }
            }
            // Begin simulation from the event that occurred after the snapshot rolled back to.
            this._next_run_event_index = i;

            this._need_to_rollback_to_index = undefined;
        }

        const function_call = this._events[this._next_run_event_index];
        if (function_call && function_call.time_stamp.time <= this._target_time) {
            const f = this._exports[function_call.function_export_index] as CallableFunction;
            f(...function_call.args);
            this._next_run_event_index += 1;
            return true;
        }
        return false;
    }

    // Take a snapshot. This provides a point in time to rollback to.
    // This should be called after significant computation has been performed.
    take_snapshot() {
        this._snapshots.push(this._get_wasm_snapshot());
    }

    remove_history_before(time: number) {
        // Remove all events and snapshots that occurred before this time.
        // Progress the safe time. 
        // Decrement _next_run_event_index.
        // Always leave at least one snapshot to rollback to.

        let i = 0;
        for (; i < this._events.length; ++i) {
            if (this._events[i].time_stamp.time >= time) {
                break;
            }
        }
        this._events.splice(0, i);
        this._next_run_event_index -= i;

        i = 0;
        // To ensure there's always atleast one snapshot to rollback to:
        // this._snapshots.length - 1 
        for (; i < this._snapshots.length - 1; ++i) {
            if (this._snapshots[i].time_stamp.time >= time) {
                break;
            }
        }
        this._snapshots.splice(0, i);
        this._earliest_safe_time = time;
    }

    private _get_wasm_snapshot(): WasmSnapshot {
        const globals: Array<[number, unknown]> = [];

        const export_values = Object.values(this._wasm_instance.instance.exports);
        for (const index of this._global_indices) {
            globals.push([index, (export_values[index] as WebAssembly.Global).value]);
        }

        // TODO: Audit if this default time_stamp makes sense
        // Are there scenarios where there'd be no function_calls when a snapshot is taken?

        let time_stamp = { time: 0, player_id: 0 };
        const function_call = this._events[this._next_run_event_index - 1];
        if (function_call) {
            time_stamp = function_call.time_stamp;
        }

        return {
            // This nested Uint8Array constructor creates a deep copy.
            memory: new Uint8Array(new Uint8Array((this._wasm_instance.instance.exports.memory as WebAssembly.Memory).buffer)),
            globals,
            time_stamp
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

    private _encode(writer: MessageWriterReader) {
        // TODO: The corresponding decode

        // Encode _earliest_safe_time
        // Encode _fixed_update_time
        // Encode _target_time
        // Encode _next_run_event_index
        // Encode _events
        // Encode _snapshot

        // For bandwidth / performance reasons only send encode
        // the earliest safe snapshot and all subsequent events.
        // It's up to the decoding TimeMachine to catchup.
        const snapshot = this._snapshots[0];
        let next_event_index = 0;
        for (; next_event_index <= this._events.length; ++next_event_index) {
            if (time_stamp_compare(this._events[next_event_index].time_stamp, snapshot.time_stamp) == 1) {
                break;
            }
        }

        writer.write_f64(this._earliest_safe_time);
        writer.write_f64(this._fixed_update_time);
        writer.write_f64(this._target_time);
        writer.write_f64(this._next_run_event_index);

        // Encode events
        writer.write_u32(this._events.length);
        for (const event of this._events) {
            writer.write_u32(event.function_export_index);
            writer.encode_time_stamp(event.time_stamp);
            writer.write_u8(event.args.length);
            for (const arg of event.args) {
                writer.write_f64(arg);
            }
        }

        // Encode the snapshot

        // Encode all mutable globals
        writer.write_u16(snapshot.globals.length);
        for (const value of snapshot.globals) {
            writer.write_u32(value[0]);
            writer.write_tagged_number(value[1] as number | bigint);
        }
        writer.write_u32(snapshot.memory.buffer.byteLength);
        writer.write_raw_bytes(new Uint8Array(snapshot.memory.buffer));
    }

}