import { Room, RoomState } from "./room.js";
import { arrayEquals, OfflineWarpCore, TimeStamp, time_stamp_less_than } from "./offline_warp_core.js";
import { MessageWriterReader } from "./message_encoding.js";

export { RoomState } from "./room.js";

type FunctionCallMessage = {
    function_name: string,
    time_stamp: TimeStamp
    args: Array<number>
}

enum MessageType {
    WasmCall,
    RequestHeap,
    SentHeap,
    TimeProgressed,
    SetProgram,
    DebugShareHistory,
    // Used to figure out roundtrip time.
    BounceBack,
    BounceBackReturn
}

type PeerData = {
    last_sent_message: number,
    last_received_message: number,
    round_trip_time: number,
}

let text_encoder = new TextEncoder();
let text_decoder = new TextDecoder();

enum WarpCoreState {
    Disconnected,
    Connected,
    RequestingHeap
}

let round_trip_time_total = 0;
let round_trip_time_average_count = 0;

export class WarpCore {
    room!: Room;
    private _warp_core!: OfflineWarpCore;
    private _buffered_messages: Array<FunctionCallMessage> = [];
    private _peer_data: Map<string, PeerData> = new Map();
    private outgoing_message_buffer = new Uint8Array(500);
    private _warp_core_state = WarpCoreState.Disconnected;
    private _current_program_binary = new Uint8Array();
    private _block_reentrancy = false;
    private _enqueued_inner_calls = new Array(Function());
    private _debug_enabled = true;

    // The simulation's time - Date.now()
    private _time_offset = 0;

    private async _run_inner_function(f: Function, enqueue_condition: boolean = false) {
        if (!this._block_reentrancy && !enqueue_condition) {
            this._block_reentrancy = true;
            await f();
            let f1 = this._enqueued_inner_calls.shift();
            while (f1) {
                await f1();
                f1 = this._enqueued_inner_calls.shift();
            }
            this._block_reentrancy = false;
        } else {
            this._enqueued_inner_calls.push(f);
        }
    }

    static async setup(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, recurring_call_interval: number, on_state_change_callback?: (state: RoomState) => void): Promise<WarpCore> {
        let warp_core = new WarpCore();
        await warp_core.setup_inner(wasm_binary, wasm_imports, recurring_call_interval, on_state_change_callback);
        return warp_core;
    }

    private request_heap() {
        // Ask an arbitrary peer for the heap
        let lowest_latency_peer = this.room.get_lowest_latency_peer();
        if (lowest_latency_peer) {
            this.room.send_message(this._encode_bounce_back_message(), lowest_latency_peer);
            this.room.send_message(this._encode_request_heap_message(), lowest_latency_peer);
        }
    }

    /// This actually encodes globals as well, not just the heap.
    private _encode_heap_message(): Uint8Array {
        // TODO: Send all function calls and events here.

        console.log("WASM MODULE SENDING: ", this._warp_core.wasm_instance!.instance.exports);
        let memory = this._warp_core.wasm_instance!.instance.exports.memory as WebAssembly.Memory;
        let encoded_data = this._warp_core.gzip_encode(new Uint8Array(memory.buffer));

        let exports = this._warp_core.wasm_instance!.instance.exports;
        let globals_count = 0;
        for (const [key, v] of Object.entries(exports)) {
            if (key.slice(0, 3) == "wg_") {
                globals_count += 1;
            }
        }
        let heap_message = new Uint8Array(encoded_data.byteLength + 1 + 8 + 8 + 4 + (8 + 4) * globals_count);
        let message_writer = new MessageWriterReader(heap_message);
        message_writer.write_u8(MessageType.SentHeap);
        message_writer.write_f64(this._warp_core.current_time);
        message_writer.write_f64(this._warp_core.recurring_call_time);
        console.log("ENCODING RECURRING CALL TIME: ", this._warp_core.recurring_call_time);

        // Encode all mutable globals
        message_writer.write_u16(globals_count);
        for (const [key, v] of Object.entries(exports)) {
            if (key.slice(0, 3) == "wg_") {
                let index = parseInt(key.match(/\d+$/)![0]);
                message_writer.write_u32(index);
                message_writer.write_f64((v as WebAssembly.Global).value);
            }
        }
        message_writer.write_raw_bytes(encoded_data);

        return heap_message;
    }

    private _decode_heap_message(data: Uint8Array) {
        let message_reader = new MessageWriterReader(data);

        let current_time = message_reader.read_f64();
        let recurring_call_time = message_reader.read_f64();
        let mutable_globals_length = message_reader.read_u16();

        let global_values = new Map();
        for (let i = 0; i < mutable_globals_length; i++) {
            let index = message_reader.read_u32();
            let value = message_reader.read_f64();
            global_values.set(index, value);
        }

        // TODO: When implemented all function calls and events need to be decoded here.
        let heap_data = this._warp_core.gzip_decode(message_reader.read_remaining_raw_bytes());

        return {
            current_time,
            recurring_call_time,
            heap_data,
            global_values
        };
    }


    private _encode_new_program_message(program_data: Uint8Array): Uint8Array {
        let encoded_data = this._warp_core.gzip_encode(program_data);

        let message = new Uint8Array(encoded_data.byteLength + 1);
        let message_writer = new MessageWriterReader(message);
        message_writer.write_u8(MessageType.SetProgram);
        message_writer.write_raw_bytes(encoded_data);

        return message;
    }

    private _decode_new_program_message(data_in: Uint8Array) {
        let data = this._warp_core.gzip_decode(data_in);
        return data;
    }

    private _encode_wasm_call_message(function_string: string, time: number, time_offset: number, args: [number], hash?: Uint8Array): Uint8Array {
        let message_writer = new MessageWriterReader(this.outgoing_message_buffer);
        message_writer.write_u8(MessageType.WasmCall);

        message_writer.write_f64(time);
        message_writer.write_f64(time_offset);
        message_writer.write_u8(args.length);


        // Encode args. 
        // TODO: For now all args are encoded as f32s, but that is incorrect.
        for (let i = 0; i < args.length; i++) {
            message_writer.write_f64(args[i]);
        }

        if (this._debug_enabled) {
            message_writer.write_raw_bytes(hash!);
        }

        // TODO: The set of possible function call names is finite per-module, so this could be
        // turned into a simple index instead of sending the whole string.
        let text_length = text_encoder.encodeInto(function_string, this.outgoing_message_buffer.subarray(message_writer.offset)).written!;
        return this.outgoing_message_buffer.subarray(0, message_writer.offset + text_length);
    }

    private _decode_wasm_call_message(data: Uint8Array) {
        let message_reader = new MessageWriterReader(data);

        let time = message_reader.read_f64();
        let time_offset = message_reader.read_f64();
        let args_length = message_reader.read_u8();

        let args = new Array<number>(args_length);
        for (let i = 0; i < args.length; i++) {
            args[i] = message_reader.read_f64();
        }

        let hash;
        if (this._debug_enabled) {
            hash = message_reader.read_fixed_raw_bytes(16);
        }

        let function_name = text_decoder.decode(data.subarray(message_reader.offset));
        return {
            function_name,
            time,
            time_offset,
            args,
            hash
        };
    }

    private _encode_time_progressed_message(time_progressed: number): Uint8Array {
        let message_writer = new MessageWriterReader(this.outgoing_message_buffer);
        message_writer.write_u8(MessageType.TimeProgressed);
        message_writer.write_f64(time_progressed);
        return message_writer.get_result_array();
    }

    private _decode_time_progressed_message(data: Uint8Array) {
        return new DataView(data.buffer, data.byteOffset).getFloat64(0);
    }

    private _encode_request_heap_message(): Uint8Array {
        this.outgoing_message_buffer[0] = MessageType.RequestHeap;
        return this.outgoing_message_buffer.subarray(0, 1);
    }

    private _encode_bounce_back_message(): Uint8Array {
        let writer = new MessageWriterReader(this.outgoing_message_buffer);
        writer.write_u8(MessageType.BounceBack);
        writer.write_f64(Date.now());
        return writer.get_result_array();
    }

    private _decode_bounce_back_return(data: Uint8Array): number {
        let reader = new MessageWriterReader(data);
        return reader.read_f64();
    }

    private _encode_share_history(): Uint8Array {
        // TODO: Don't use a fixed size buffer and instead resize if necessary.
        let data = new Uint8Array(50_000);

        let message_writer = new MessageWriterReader(data);
        message_writer.write_u8(MessageType.DebugShareHistory);

        let history_length = this._warp_core.function_calls.length;

        for (let i = 0; i < history_length; i++) {

            let function_call = this._warp_core.function_calls[i];
            message_writer.write_f64(function_call.time_stamp.time);
            message_writer.write_f64(function_call.time_stamp.offset);
            message_writer.write_raw_bytes(function_call.hash_after!);

            message_writer.write_string(function_call.name);
        }

        return message_writer.get_result_array();
    }

    private _decode_share_history(data: Uint8Array) {
        let history = [];

        let message_reader = new MessageWriterReader(data);

        while (message_reader.offset < data.length) {
            let time = message_reader.read_f64();
            let time_offset = message_reader.read_f64();
            let hash = message_reader.read_fixed_raw_bytes(16);
            let function_name = message_reader.read_string();

            history.push({
                time,
                time_offset,
                hash,
                function_name
            });
        }
        return history;
    }

    private async setup_inner(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, recurring_call_interval: number, on_state_change_callback?: (state: RoomState) => void) {
        let room_configuration = {
            on_peer_joined: (peer_id: string) => {
                this._run_inner_function(async () => {
                    this._peer_data.set(peer_id, {
                        last_sent_message: 0,
                        last_received_message: Number.MAX_VALUE,
                        round_trip_time: 0,
                    });
                    this.room.send_message(this._encode_bounce_back_message(), peer_id);
                });
            },
            on_peer_left: (peer_id: string) => {
                this._run_inner_function(async () => {
                    console.log("REMOVE PEER");
                    this._peer_data.delete(peer_id);
                });
            },
            on_state_change: (state: RoomState) => {
                this._run_inner_function(async () => {
                    // TODO: Change this callback to have room passed in.

                    console.log("[warpcore] Room state changed: ", RoomState[state]);

                    switch (state) {
                        case RoomState.Connected: {
                            this._warp_core_state = WarpCoreState.Connected;
                            this.request_heap();
                            break;
                        }
                        case RoomState.Disconnected: {
                            this._warp_core_state = WarpCoreState.Disconnected;
                            break;
                        }
                        case RoomState.Joining: {
                            this._warp_core_state = WarpCoreState.Disconnected;
                            break;
                        }
                    }

                    // TODO: Make this callback with WarpCoreState instead.
                    on_state_change_callback?.(state);
                });
            },
            on_message: async (peer_id: string, message: Uint8Array) => {
                let peer_connected_already = this._peer_data.get(peer_id);

                this._run_inner_function(async () => {
                    // Ignore messages from peers that have disconnected. 
                    // TODO: Evaluate if this could cause desyncs.

                    if (!this._peer_data.get(peer_id!)) {
                        return;
                    }

                    let message_type = message[0];
                    let message_data = message.subarray(1);

                    switch (message_type) {
                        case (MessageType.TimeProgressed): {
                            let time = this._decode_time_progressed_message(message_data);
                            this._peer_data.get(peer_id)!.last_received_message = time;
                            break;
                        }
                        case (MessageType.WasmCall): {
                            let m = this._decode_wasm_call_message(message_data);
                            this._peer_data.get(peer_id)!.last_received_message = m.time;

                            let time_stamp = {
                                time: m.time,
                                offset: m.time_offset,
                                player_id: 0 // TODO:
                            };
                            if (this._warp_core_state == WarpCoreState.RequestingHeap) {
                                this._buffered_messages.push({
                                    function_name: m.function_name,
                                    time_stamp: time_stamp,
                                    args: m.args
                                });
                            } else {
                                await this._progress_time_inner(m.time - this._warp_core.current_time);

                                // TODO: Could this be reentrant if incoming messages aren't respecting the async-ness?
                                let index = await this._warp_core.call_with_time_stamp(time_stamp, m.function_name, m.args);

                                let hash_after = this._warp_core.function_calls[index].hash_after;

                                if (m.hash && !arrayEquals(m.hash, hash_after!)) {
                                    console.error("DESYNC DETECTED! SENDING HISTORY");
                                    this.room.send_message(this._encode_share_history(), peer_id);

                                    console.log("FUNCTION CALLS: ", structuredClone(this._warp_core.function_calls));
                                    console.log("EXPECTED HASH AFTER: ", m.hash);
                                    // console.log("HASH BEFORE REMOTE CALL: ", this._warp_core.function_calls[index - 1].hash_after);
                                    console.log("HASH AFTER REMOTE CALL: ", hash_after);
                                }
                            }

                            break;
                        }
                        case (MessageType.RequestHeap): {
                            // Also send the program binary.
                            let program_message = this._encode_new_program_message(this._current_program_binary);
                            this.room.send_message(program_message);

                            let heap_message = this._encode_heap_message();
                            this.room.send_message(heap_message);
                            break;
                        }
                        case (MessageType.SentHeap): {
                            console.log("[warpcore] Setting heap");
                            let heap_message = this._decode_heap_message(message_data);

                            // TODO: Get roundtrip time to peer and increase current_time by half of that.
                            let round_trip_average = round_trip_time_total / round_trip_time_average_count;
                            console.log("[warpcore] Approximate round trip offset: ", round_trip_average / 2);

                            let current_time = heap_message.current_time;

                            this._time_offset = (Date.now() - heap_message.current_time);

                            console.log("INITIAL RECURRING CALL TIME: ", heap_message.recurring_call_time);
                            await this._warp_core.reset_with_wasm_memory(
                                heap_message.heap_data,
                                heap_message.global_values,
                                current_time + (round_trip_average / 2),
                                heap_message.recurring_call_time,
                            );

                            for (let m of this._buffered_messages) {
                                await this._warp_core.call_with_time_stamp(m.time_stamp, m.function_name, m.args);
                            }
                            this._buffered_messages = [];
                            break;
                        }
                        case (MessageType.SetProgram): {
                            // TODO: This is incorrect. Make sure all peers are aware of their roundtrip average with each-other
                            let round_trip_average = 0;
                            if (round_trip_time_average_count != 0) {
                                round_trip_average = round_trip_time_total / round_trip_time_average_count;

                            }
                            console.log("[warpcore] Approximate round trip offset: ", round_trip_average);

                            console.log("SETTING PROGRAM!");
                            let new_program = this._decode_new_program_message(message_data);
                            this._current_program_binary = new_program;
                            await this._warp_core.reset_with_new_program(new_program, round_trip_average);
                            console.log("DONE SETTING PROGRAM");
                            break;
                        }
                        case (MessageType.DebugShareHistory): {
                            let remote_history = this._decode_share_history(message_data);
                            console.log("RECEIVED SHARED HISTORY DUE TO DESYNC");
                            console.log("SHARED HISTORY: ", this._decode_share_history(message_data));

                            let i = 0;
                            let j = 0;
                            while (i < this._warp_core.function_calls.length && j < remote_history.length) {
                                let f0 = this._warp_core.function_calls[i];
                                let f1 = remote_history[j];

                                let time_stamp1 = {
                                    time: f1.time,
                                    offset: f1.time_offset,
                                    player_id: 0 // TODO: Real player ID
                                };

                                if (time_stamp_less_than(f0.time_stamp, time_stamp1)) {
                                    i += 1;
                                } else if (time_stamp_less_than(time_stamp1, f0.time_stamp)) {
                                    j += 1;
                                } else {
                                    // They are equal. Compare properties:
                                    if (!arrayEquals(f0.hash_after!, f1.hash)) {
                                        console.log('DESYNC. LOCAL INDEX: %d REMOTE INDEX: %d', i, j);
                                    }
                                    i += 1;
                                    j += 1;
                                }
                            }
                            break;
                        }
                        case (MessageType.BounceBack): {
                            message[0] = MessageType.BounceBackReturn;
                            this.room.send_message(message, peer_id);
                            break;
                        }
                        case (MessageType.BounceBackReturn): {
                            let time = this._decode_bounce_back_return(message_data);
                            round_trip_time_total += Date.now() - time;
                            round_trip_time_average_count += 1;
                            break;
                        }
                    }
                }, !peer_connected_already);
            }
        };
        this._warp_core = await OfflineWarpCore.setup(wasm_binary, wasm_imports, recurring_call_interval);
        this.room = await Room.setup(room_configuration);
        this._current_program_binary = wasm_binary;
    }

    set_program(new_program: Uint8Array) {
        this._run_inner_function(async () => {
            //   if (!arrayEquals(new_program, this._current_program_binary)) {
            await this._warp_core.reset_with_new_program(
                new_program,
                0
            );
            this._current_program_binary = new_program;

            console.log("SENDING NEW PROGRAM MESSAGE!");
            this.room.send_message(this._encode_new_program_message(new_program));
            // }
        });
    }

    call(function_name: string, args: [number]) {
        this._run_inner_function(async () => {
            let time_stamp = this._warp_core.next_time_stamp();

            let new_function_call_index = await this._warp_core.call_with_time_stamp(time_stamp, function_name, args);

            let hash_after = this._warp_core.function_calls[new_function_call_index].hash_after;

            // Network the call
            this.room.send_message(this._encode_wasm_call_message(function_name, time_stamp.time, time_stamp.offset, args, hash_after));

            for (let [_, value] of this._peer_data) {
                value.last_sent_message = Math.max(value.last_received_message, time_stamp.time);
            }
        });
    }

    /// This call will have no impact but can be useful to draw or query from the world.
    call_and_revert(function_name: string, args: [number]) {
        this._run_inner_function(async () => {
            this._warp_core.call_and_revert(function_name, args);
        });
    }

    /// Resync with the room, immediately catching up.
    resync() {
        // TODO: Check for reentrancy
        console.log("REQUESTING HEAP!");
        this.request_heap();
    }

    private async _progress_time_inner(time_progressed: number) {
        // TODO: Check for reentrancy

        // TODO: Check if too much time is being progressed and if so consider a catchup strategy
        // or consider just disconnecting and reconnecting.
        let steps_remaining = this._warp_core.steps_remaining(time_progressed);

        // TODO: Detect if we're falling behind and can't keep up.


        await this._warp_core.progress_time(time_progressed);

        // Keep track of when a message was received from each peer
        // and use that to determine what history is safe to throw away.
        let earliest_safe_memory = this._warp_core.recurring_call_time;
        for (let [_, value] of this._peer_data) {
            earliest_safe_memory = Math.min(earliest_safe_memory, value.last_received_message);

            // If we haven't message our peers in a while send them a message
            // This lets them know nothing has happened and they can clear memory.
            // I suspect the underlying RTCDataChannel protocol is sending keep alives as well,
            // it'd be better to figure out if those could be used instead.
            const KEEP_ALIVE_THRESHOLD = 200;
            if ((this._warp_core.current_time - value.last_sent_message) > KEEP_ALIVE_THRESHOLD) {

                this.room.send_message(this._encode_time_progressed_message(this._warp_core.current_time));
            }
        }

        // This -100 is for debugging purposes only
        this._warp_core.remove_history_before(earliest_safe_memory - 100);

    }
    progress_time(time_progressed: number) {
        this._run_inner_function(async () => {
            await this._progress_time_inner(time_progressed);
        });
    }

    share_history() {
        console.log(this._decode_share_history(this._encode_share_history()));
        // this.room.send_message(this._encode_share_history());
    }
    get_memory(): WebAssembly.Memory {
        return this._warp_core.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
    }
}

