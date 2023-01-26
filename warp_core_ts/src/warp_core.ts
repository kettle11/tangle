import { Room, RoomState } from "./room.js";
import { OfflineWarpCore, TimeStamp } from "./offline_warp_core.js";

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
}

type PeerData = {
    last_sent_message: number,
    last_received_message: number,
}

let text_encoder = new TextEncoder();
let text_decoder = new TextDecoder();

enum WarpCoreState {
    Disconnected,
    Connected,
    RequestingHeap
}

export class WarpCore {
    room!: Room;
    private _warp_core!: OfflineWarpCore;
    private _buffered_messages: Array<FunctionCallMessage> = [];
    private _peer_data: Map<string, PeerData> = new Map();
    private outgoing_message_buffer = new Uint8Array(500);
    private _warp_core_state = WarpCoreState.Disconnected;
    private _current_program_binary = new Uint8Array();
    private _block_reentrancy = false;
    private _enqueued_messages = new Array<Uint8Array>;

    static async setup(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, recurring_call_interval: number, on_state_change_callback?: (state: RoomState) => void): Promise<WarpCore> {
        let warp_core = new WarpCore();
        await warp_core.setup_inner(wasm_binary, wasm_imports, recurring_call_interval, on_state_change_callback);
        return warp_core;
    }

    private request_heap() {
        // Ask an arbitrary peer for the heap
        let lowest_latency_peer = this.room.get_lowest_latency_peer();
        if (lowest_latency_peer) {
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
        let heap_message = new Uint8Array(encoded_data.byteLength + 1 + 8 + 4 + (8 + 4) * globals_count);
        heap_message[0] = MessageType.SentHeap;
        let data_view = new DataView(heap_message.buffer);
        data_view.setFloat32(1, this._warp_core.current_time);
        data_view.setFloat32(5, this._warp_core.recurring_call_time);

        // Encode all mutable globals

        let offset = 11;
        for (const [key, v] of Object.entries(exports)) {
            if (key.slice(0, 3) == "wg_") {
                let index = parseInt(key.match(/\d+$/)![0]);
                console.log("GLOBAL INDEX: ", index);
                data_view.setUint32(offset, index);
                offset += 4;
                data_view.setFloat64(offset, (v as WebAssembly.Global).value);
                offset += 8;
            }
        }
        data_view.setUint16(9, globals_count);

        heap_message.set(encoded_data, offset);

        return heap_message;
    }

    private _decode_heap_message(data: Uint8Array) {
        let data_view = new DataView(data.buffer, data.byteOffset);
        let current_time = data_view.getFloat32(0);
        let recurring_call_time = data_view.getFloat32(4);
        let mutable_globals_length = data_view.getUint16(8);

        let offset = 10;
        let global_values = new Map();
        for (let i = 0; i < mutable_globals_length; i++) {
            let index = data_view.getUint32(offset);
            offset += 4;
            let value = data_view.getFloat64(offset);
            offset += 8;
            global_values.set(index, value);
        }

        // TODO: When implemented all function calls and events need to be decoded here.

        let heap_data = this._warp_core.gzip_decode(data.subarray(offset))

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
        message[0] = MessageType.SetProgram;
        message.set(encoded_data, 1);

        return message;
    }

    private _decode_new_program_message(data_in: Uint8Array) {
        let data = this._warp_core.gzip_decode(data_in);
        return data;
    }

    private _encode_wasm_call_message(function_string: string, time: number, time_offset: number, args: [number]): Uint8Array {
        this.outgoing_message_buffer[0] = MessageType.WasmCall;
        let data_view = new DataView(this.outgoing_message_buffer.buffer);
        data_view.setFloat32(1, time);
        data_view.setFloat32(5, time_offset);
        this.outgoing_message_buffer[9] = args.length;
        let offset = 10;

        // Encode args. 
        // TODO: For now all args are encoded as f32s, but that is incorrect.
        for (let i = 0; i < args.length; i++) {
            data_view.setFloat32(offset, args[i]);
            offset += 4;
        }

        // TODO: The set of possible functionc call names is finite per-module, so this could be
        // turned into a simple index instead of sending the whole string.
        offset += text_encoder.encodeInto(function_string, this.outgoing_message_buffer.subarray(offset)).written!;
        return this.outgoing_message_buffer.subarray(0, offset);
    }

    private _decode_wasm_call_message(data: Uint8Array) {
        let data_view = new DataView(data.buffer, data.byteOffset);
        let time = data_view.getFloat32(0);
        let time_offset = data_view.getFloat32(4);
        let args_length = data[8];

        let args = new Array<number>(args_length);
        let offset = 9;
        for (let i = 0; i < args.length; i++) {
            args[i] = data_view.getFloat32(offset);
            offset += 4;
        }

        let function_name = text_decoder.decode(data.subarray(offset));
        return {
            function_name,
            time,
            time_offset,
            args
        };
    }

    private _encode_time_progressed_message(time_progressed: number): Uint8Array {
        this.outgoing_message_buffer[0] = MessageType.TimeProgressed;
        new DataView(this.outgoing_message_buffer.buffer, 1).setFloat32(0, time_progressed);
        return this.outgoing_message_buffer.subarray(0, 5);
    }

    private _decode_time_progressed_message(data: Uint8Array) {
        return new DataView(data.buffer, data.byteOffset).getFloat32(0);
    }

    private _encode_request_heap_message(): Uint8Array {
        this.outgoing_message_buffer[0] = MessageType.RequestHeap;
        return this.outgoing_message_buffer.subarray(0, 1);
    }

    private async setup_inner(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, recurring_call_interval: number, on_state_change_callback?: (state: RoomState) => void) {
        let room_configuration = {
            on_peer_joined: (peer_id: string) => {
                this._peer_data.set(peer_id, {
                    last_sent_message: 0,
                    last_received_message: Number.MAX_VALUE,
                });
            },
            on_peer_left: (peer_id: string) => {
                this._peer_data.delete(peer_id);
            },
            on_state_change: (state: RoomState) => {
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
            },
            on_message: async (peer_id: string, message_in: Uint8Array) => {
                this._enqueued_messages.push(message_in);

                // Messages coming in could be reentrant because of internal awaits.
                // TODO: Extend this to all calls into WarpCore.
                if (this._block_reentrancy) {
                    return;
                }
                this._block_reentrancy = true;
                while (this._enqueued_messages.length > 0) {
                    let message = this._enqueued_messages.shift()!;
                    // TODO: Make this not reentrant.
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
                                await this.progress_time(m.time - this._warp_core.current_time);

                                // TODO: Could this be reentrant if incoming messages aren't respecting the async-ness?
                                let _ = await this._warp_core.call_with_time_stamp(time_stamp, m.function_name, m.args);
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
                            let heap_message = this._decode_heap_message(message_data);
                            await this._warp_core.reset_with_wasm_memory(
                                heap_message.heap_data,
                                heap_message.global_values,
                                heap_message.current_time,
                                heap_message.recurring_call_time,
                            );

                            for (let m of this._buffered_messages) {
                                await this._warp_core.call_with_time_stamp(m.time_stamp, m.function_name, m.args);
                            }
                            this._buffered_messages = [];
                            break;
                        }
                        case (MessageType.SetProgram): {
                            console.log("SETTING PROGRAM!");
                            let new_program = this._decode_new_program_message(message_data);
                            this._current_program_binary = new_program;
                            await this._warp_core.reset_with_new_program(new_program);
                            console.log("DONE SETTING PROGRAM");
                        }
                    }
                }
                this._block_reentrancy = false;
            }
        };
        this._warp_core = await OfflineWarpCore.setup(wasm_binary, wasm_imports, recurring_call_interval);
        this.room = await Room.setup(room_configuration);
        this._current_program_binary = wasm_binary;
    }

    async set_program(new_program: Uint8Array) {
        await this._warp_core.reset_with_new_program(
            new_program,
        );
        this._current_program_binary = new_program;
        this.room.send_message(this._encode_new_program_message(new_program));
    }

    async call(function_name: string, args: [number]) {
        // TODO: Check for reentrancy

        let time_stamp = this._warp_core.next_time_stamp();
        let new_function_call_index = await this._warp_core.call_with_time_stamp(time_stamp, function_name, args);

        // Network the call
        this.room.send_message(this._encode_wasm_call_message(function_name, time_stamp.time, time_stamp.offset, args));

        for (let [_, value] of this._peer_data) {
            value.last_sent_message = Math.max(value.last_received_message, time_stamp.time);
        }

    }

    /// This call will have no impact but can be useful to draw or query from the world.
    async call_and_revert(function_name: string, args: [number]) {
        // TODO: Check for reentrancy

        this._warp_core.call_and_revert(function_name, args);
    }

    /// Resync with the room, immediately catching up.
    resync() {
        // TODO: Check for reentrancy
        console.log("REQUESTING HEAP!");
        this.request_heap();
    }

    async progress_time(time_progressed: number) {
        // TODO: Check for reentrancy

        // TODO: Check if too much time is being progressed and if so consider a catchup strategy
        // or consider just disconnecting and reconnecting.
        let steps_remaining = this._warp_core.steps_remaining(time_progressed);

        // TODO: Detect if we're falling behind and can't keep up.

        // If we've fallen too far behind resync and catchup.
        if (steps_remaining > 20 && this._peer_data.size > 0) {
            // this.request_heap();
        } else {

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

            // This - 300 is for debugging purposes only
            this.remove_history_before(earliest_safe_memory - 300);
        }
    }

    private remove_history_before(time_exclusive: number) {
        this._warp_core.remove_history_before(time_exclusive);
    }

    get_memory(): WebAssembly.Memory {
        return this._warp_core.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
    }
}

