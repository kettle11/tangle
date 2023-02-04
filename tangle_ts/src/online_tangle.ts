import { PeerId, Room, RoomState } from "./room.js";
import { arrayEquals, OfflineTangle, TimeStamp, RustUtilities } from "./offline_tangle.js";
import { MessageWriterReader } from "./message_encoding.js";

export { RoomState, PeerId } from "./room.js";

type FunctionCallMessage = {
    function_name: string,
    time_stamp: TimeStamp
    args: Array<number>
}

enum MessageType {
    WasmCall,
    TimeProgressed,
    RequestState,
    SetProgram,
    SetHeap,
    // Used to figure out roundtrip time.
    Ping,
    Pong
}

type PeerData = {
    last_sent_message: number,
    last_received_message: number,
    round_trip_time: number,
}

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

export enum TangleState {
    Disconnected,
    Connected,
    RequestingHeap
}

type TangleConfiguration = {
    fixed_update_interval?: number;
    on_state_change_callback?: (state: TangleState, tangle: Tangle) => void
    accept_new_programs?: boolean,
}

class UserIdType { }
export const UserId = new UserIdType();

export class Tangle {
    private _room!: Room;
    private _offline_tangle!: OfflineTangle;
    private _rust_utilities: RustUtilities;

    private _buffered_messages: Array<FunctionCallMessage> = [];
    private _peer_data: Map<PeerId, PeerData> = new Map();
    private _tangle_state = TangleState.Disconnected;
    private _current_program_binary = new Uint8Array();
    private _block_reentrancy = false;
    private _enqueued_inner_calls: Array<() => void> = [];
    private _last_performance_now?: number;
    private _configuraton?: TangleConfiguration;
    private _outgoing_message_buffer = new Uint8Array(500);


    // private _debug_enabled = true;

    static async setup(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, tangle_configuration?: TangleConfiguration): Promise<Tangle> {
        tangle_configuration ??= {};
        tangle_configuration.accept_new_programs ??= false;
        tangle_configuration.fixed_update_interval ??= 0;

        const offline_tangle = await OfflineTangle.setup(wasm_binary, wasm_imports, tangle_configuration.fixed_update_interval);

        const tangle = new Tangle(offline_tangle);
        await tangle.setup_inner(offline_tangle, wasm_binary, wasm_imports, tangle_configuration);
        return tangle;
    }

    constructor(offline_tangle: OfflineTangle) {
        this._offline_tangle = offline_tangle;
        this._rust_utilities = offline_tangle.rust_utilities;
    }

    private async setup_inner(offline_tangle: OfflineTangle, wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, configuration?: TangleConfiguration) {
        const room_configuration = {
            on_peer_joined: (peer_id: PeerId) => {
                this._run_inner_function(async () => {
                    this._peer_data.set(peer_id, {
                        last_sent_message: 0,
                        last_received_message: Number.MAX_VALUE,
                        round_trip_time: 0,
                    });
                    this._room.send_message(this._encode_bounce_back_message(), peer_id);
                });
            },
            on_peer_left: (peer_id: PeerId, time: number) => {
                this._run_inner_function(async () => {
                    this._peer_data.delete(peer_id);

                    // TODO: This is not a good way to synchronize when a peer disconnects.
                    // It will likely work in some cases but it could also easily desync.

                    time = ((this._offline_tangle.current_time + 1000) % 500) + this._offline_tangle.current_time;
                    if (time < this.earliest_safe_memory_time()) {
                        console.error("ERROR: POTENTIAL DESYNC DUE TO PEER LEAVING!");
                    }

                    const time_stamp = {
                        time,
                        player_id: 0 // 0 is for events sent by the server.
                    };

                    console.log("[tangle] calling 'peer_left'");
                    this._offline_tangle.call_with_time_stamp(time_stamp, "peer_left", [peer_id]);
                });
            },
            on_state_change: (state: RoomState) => {
                this._run_inner_function(async () => {
                    // TODO: Change this callback to have room passed in.

                    console.log("[tangle] Room state changed: ", RoomState[state]);

                    switch (state) {
                        case RoomState.Connected: {
                            this._request_heap();

                            if (this._peer_data.size == 0) {
                                // We have no peer so we're connected
                                this._tangle_state = TangleState.Connected;
                                configuration?.on_state_change_callback?.(this._tangle_state, this);
                            }
                            break;
                        }
                        case RoomState.Disconnected: {
                            this._tangle_state = TangleState.Disconnected;
                            configuration?.on_state_change_callback?.(this._tangle_state, this);
                            break;
                        }
                        case RoomState.Joining: {
                            this._tangle_state = TangleState.Disconnected;
                            configuration?.on_state_change_callback?.(this._tangle_state, this);
                            break;
                        }
                    }

                });
            },
            on_message: async (peer_id: PeerId, message: Uint8Array) => {
                const peer_connected_already = this._peer_data.get(peer_id);

                this._run_inner_function(async () => {
                    // Ignore messages from peers that have disconnected. 
                    // TODO: Evaluate if this could cause desyncs.
                    const peer = this._peer_data.get(peer_id);
                    if (!peer) {
                        return;
                    }

                    const message_type = message[0];
                    const message_data = message.subarray(1);

                    switch (message_type) {
                        case (MessageType.TimeProgressed): {
                            const time = this._decode_time_progressed_message(message_data);
                            peer.last_received_message = time;
                            break;
                        }
                        case (MessageType.WasmCall): {
                            const m = this._decode_wasm_call_message(message_data);
                            peer.last_received_message = m.time;

                            const time_stamp = {
                                time: m.time,
                                player_id: peer_id
                            };

                            if (this._tangle_state == TangleState.RequestingHeap) {
                                this._buffered_messages.push({
                                    function_name: m.function_name,
                                    time_stamp: time_stamp,
                                    args: m.args
                                });
                            } else {
                                await this._offline_tangle.call_with_time_stamp(time_stamp, m.function_name, m.args);
                            }

                            break;
                        }
                        case (MessageType.RequestState): {
                            if (this._configuraton?.accept_new_programs) {
                                // Also send the program binary.
                                const program_message = this._encode_new_program_message(this._current_program_binary);
                                this._room.send_message(program_message);
                            }

                            const heap_message = this._encode_heap_message();
                            this._room.send_message(heap_message);
                            break;
                        }
                        case (MessageType.SetProgram): {
                            if (!this._configuraton?.accept_new_programs) {
                                console.log("[tangle] Rejecting call to change programs");
                                return;
                            }

                            console.log("[tangle] Changing programs");

                            // TODO: This is incorrect. Make sure all peers are aware of their roundtrip average with each-other
                            const round_trip_time = peer.round_trip_time;
                            console.log("[tangle] Round trip offset: ", round_trip_time / 2);

                            const new_program = this._decode_new_program_message(message_data);
                            this._current_program_binary = new_program;
                            await this._offline_tangle.reset_with_new_program(new_program, (round_trip_time / 2));
                            break;
                        }
                        case (MessageType.SetHeap): {
                            console.log("[tangle] Setting heap");
                            const heap_message = this._decode_heap_message(message_data);

                            // TODO: Get roundtrip time to peer and increase current_time by half of that.
                            const round_trip_time = peer.round_trip_time;
                            console.log("[tangle] Approximate round trip offset: ", round_trip_time / 2);

                            const current_time = heap_message.current_time;

                            await this._offline_tangle.reset_with_wasm_memory(
                                heap_message.heap_data,
                                heap_message.global_values,
                                current_time + (round_trip_time / 2),
                                heap_message.recurring_call_time,
                            );

                            for (const m of this._buffered_messages) {
                                await this._offline_tangle.call_with_time_stamp(m.time_stamp, m.function_name, m.args);
                            }
                            this._buffered_messages = [];

                            this._tangle_state = TangleState.Connected;
                            configuration?.on_state_change_callback?.(this._tangle_state, this);
                            break;
                        }
                        case (MessageType.Ping): {
                            message[0] = MessageType.Pong;
                            this._room.send_message(message, peer_id);
                            break;
                        }
                        case (MessageType.Pong): {
                            const time = this._decode_bounce_back_return(message_data);
                            peer.round_trip_time = Date.now() - time;
                            break;
                        }
                    }
                }, !peer_connected_already);
            }
        };

        this._room = await Room.setup(room_configuration);
        this._current_program_binary = wasm_binary;
    }

    private async _run_inner_function(f: () => void, enqueue_condition = false) {
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

    private _request_heap() {
        // Ask an arbitrary peer for the heap
        const lowest_latency_peer = this._room.get_lowest_latency_peer();
        if (lowest_latency_peer) {
            this._room.send_message(this._encode_bounce_back_message(), lowest_latency_peer);
            this._room.send_message(this._encode_request_heap_message(), lowest_latency_peer);
        }
    }

    /// This actually encodes globals as well, not just the heap.
    private _encode_heap_message(): Uint8Array {
        // MAJOR TODO: State needs to be sent so that it's safe for the peer to rollback.
        const memory = this._offline_tangle.wasm_instance.instance.exports.memory as WebAssembly.Memory;
        const encoded_data = this._rust_utilities.gzip_encode(new Uint8Array(memory.buffer));

        const exports = this._offline_tangle.wasm_instance.instance.exports;
        let globals_count = 0;
        for (const key of Object.keys(exports)) {
            if (key.slice(0, 3) == "wg_") {
                globals_count += 1;
            }
        }
        const heap_message = new Uint8Array(encoded_data.byteLength + 1 + 8 + 8 + 4 + (8 + 4 + 1) * globals_count);
        const message_writer = new MessageWriterReader(heap_message);
        message_writer.write_u8(MessageType.SetHeap);
        message_writer.write_f64(this._offline_tangle.current_time);
        message_writer.write_f64(this._offline_tangle.recurring_call_time);

        // Encode all mutable globals
        message_writer.write_u16(globals_count);
        for (const [key, v] of Object.entries(exports)) {
            if (key.slice(0, 3) == "wg_") {
                // Get the index off the end of the name.
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const index = parseInt(key.match(/\d+$/)![0]);
                message_writer.write_u32(index);
                message_writer.write_tagged_number((v as WebAssembly.Global).value);
            }
        }
        message_writer.write_raw_bytes(encoded_data);

        return heap_message;
    }

    private _decode_heap_message(data: Uint8Array) {
        const message_reader = new MessageWriterReader(data);

        const current_time = message_reader.read_f64();
        const recurring_call_time = message_reader.read_f64();
        const mutable_globals_length = message_reader.read_u16();

        const global_values = new Map();
        for (let i = 0; i < mutable_globals_length; i++) {
            const index = message_reader.read_u32();
            const value = message_reader.read_tagged_number();
            global_values.set(index, value);
        }

        // TODO: When implemented all function calls and events need to be decoded here.
        const heap_data = this._rust_utilities.gzip_decode(message_reader.read_remaining_raw_bytes());

        return {
            current_time,
            recurring_call_time,
            heap_data,
            global_values
        };
    }


    private _encode_new_program_message(program_data: Uint8Array): Uint8Array {
        const encoded_data = this._rust_utilities.gzip_encode(program_data);

        const message = new Uint8Array(encoded_data.byteLength + 1);
        const message_writer = new MessageWriterReader(message);
        message_writer.write_u8(MessageType.SetProgram);
        message_writer.write_raw_bytes(encoded_data);

        return message;
    }

    private _decode_new_program_message(data_in: Uint8Array) {
        const data = this._rust_utilities.gzip_decode(data_in);
        return data;
    }

    private _encode_wasm_call_message(function_string: string, time: number, args: Array<number> /*, hash?: Uint8Array*/): Uint8Array {
        const message_writer = new MessageWriterReader(this._outgoing_message_buffer);
        message_writer.write_u8(MessageType.WasmCall);

        message_writer.write_f64(time);
        message_writer.write_u8(args.length);


        // Encode args. 
        // TODO: For now all args are encoded as f64s, but that is incorrect.
        for (let i = 0; i < args.length; i++) {
            message_writer.write_f64(args[i]);
        }

        /*
        if (this._debug_enabled) {
            message_writer.write_raw_bytes(hash!);
        }
        */

        // TODO: The set of possible function call names is finite per-module, so this could be
        // turned into a simple index instead of sending the whole string.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const text_length = text_encoder.encodeInto(function_string, this._outgoing_message_buffer.subarray(message_writer.offset)).written!;
        return this._outgoing_message_buffer.subarray(0, message_writer.offset + text_length);
    }

    private _decode_wasm_call_message(data: Uint8Array) {
        const message_reader = new MessageWriterReader(data);

        const time = message_reader.read_f64();
        const args_length = message_reader.read_u8();

        const args = new Array<number>(args_length);
        for (let i = 0; i < args.length; i++) {
            args[i] = message_reader.read_f64();
        }

        let hash;

        /*
        let hash;
        if (this._debug_enabled) {
            hash = message_reader.read_fixed_raw_bytes(16);
        }
        */

        const function_name = text_decoder.decode(data.subarray(message_reader.offset));
        return {
            function_name,
            time,
            args,
            hash
        };
    }

    private _encode_time_progressed_message(time_progressed: number): Uint8Array {
        const message_writer = new MessageWriterReader(this._outgoing_message_buffer);
        message_writer.write_u8(MessageType.TimeProgressed);
        message_writer.write_f64(time_progressed);
        return message_writer.get_result_array();
    }

    private _decode_time_progressed_message(data: Uint8Array) {
        return new DataView(data.buffer, data.byteOffset).getFloat64(0);
    }

    private _encode_request_heap_message(): Uint8Array {
        this._outgoing_message_buffer[0] = MessageType.RequestState;
        return this._outgoing_message_buffer.subarray(0, 1);
    }

    private _encode_bounce_back_message(): Uint8Array {
        const writer = new MessageWriterReader(this._outgoing_message_buffer);
        writer.write_u8(MessageType.Ping);
        writer.write_f64(Date.now());
        return writer.get_result_array();
    }

    private _decode_bounce_back_return(data: Uint8Array): number {
        const reader = new MessageWriterReader(data);
        return reader.read_f64();
    }

    set_program(new_program: Uint8Array) {
        this._run_inner_function(async () => {
            if (!arrayEquals(new_program, this._current_program_binary)) {
                await this._offline_tangle.reset_with_new_program(
                    new_program,
                    0
                );
                this._current_program_binary = new_program;

                this._room.send_message(this._encode_new_program_message(new_program));
            }
        });
    }

    private _process_args(args: Array<number | UserIdType>): Array<number> {
        return args.map((a) => {
            if (typeof a != "number") {
                // Assume this is a UserId
                return this._room.my_id;
            } else {
                return a;
            }
        });
    }

    call(function_name: string, args: Array<number | UserIdType>) {
        this._run_inner_function(async () => {

            // TODO: Only process the args like this for local calls.
            // Let remote calls insert the ID themselves
            // As-is this design makes it trivial for peers to spoof each-other.
            const args_processed = this._process_args(args);

            // TODO: Ensure each message has a unique timestamp.
            const time_stamp = {
                time: this._offline_tangle.current_time,
                player_id: this._room.my_id
            };

            // Adding time delay here decreases responsivity but also decreases the likelihood
            // peers will have to rollback.
            // This could be a good place to add delay if a peer has higher latency than 
            // everyone else in the room.
            // Adding a time delay would look something like this:
            // time_stamp.time += 50;

            await this._offline_tangle.call_with_time_stamp(time_stamp, function_name, args_processed);

            // Network the call
            this._room.send_message(this._encode_wasm_call_message(function_name, time_stamp.time, args_processed));

            for (const value of this._peer_data.values()) {
                value.last_sent_message = Math.max(value.last_received_message, time_stamp.time);
            }
        });
    }

    /// This call will have no impact but can be useful to draw or query from the world.
    call_and_revert(function_name: string, args: Array<number>) {
        this._run_inner_function(async () => {
            const args_processed = this._process_args(args);
            this._offline_tangle.call_and_revert(function_name, args_processed);
        });
    }

    /// Resync with the room, immediately catching up.
    resync() {
        this._run_inner_function(() => {
            this._request_heap();
        });
    }

    private earliest_safe_memory_time(): number {
        let earliest_safe_memory = this._offline_tangle.recurring_call_time;
        for (const [, value] of this._peer_data) {
            earliest_safe_memory = Math.min(earliest_safe_memory, value.last_received_message);
        }
        return earliest_safe_memory;
    }

    private async _progress_time_inner() {
        const performance_now = performance.now();

        if (this._last_performance_now) {

            const time_progressed = performance_now - this._last_performance_now;

            // Detect if we've fallen behind and need to resynchronize with the room.
            // This likely occurs in scenarios where connections are a atrocious (in which case this might not be the right check)
            // or when a tab is suspended for a bit.
            if (((this._offline_tangle.recurring_call_time + time_progressed) - this._offline_tangle.recurring_call_time) > 2000) {
                // TODO: This time change means that this peer cannot be trusted as an authority on the room simulation.
                // The peer should stop sending events and should absolutely not synchronize state with other peers.
                this._offline_tangle.recurring_call_time = this._offline_tangle.recurring_call_time + time_progressed;

                if (this._peer_data.size > 0) {
                    console.log("[tangle] Fallen over 2 seconds behind, attempting to resync with room");
                    this._request_heap();
                } else {
                    console.log("[tangle] Fallen over 2 seconds behind but this is a single-player session, so ignoring this");
                }
            }

            await this._offline_tangle.progress_time(time_progressed);

            // Keep track of when a message was received from each peer
            // and use that to determine what history is safe to throw away.
            let earliest_safe_memory = this._offline_tangle.recurring_call_time;
            for (const [peer_id, value] of this._peer_data) {
                earliest_safe_memory = Math.min(earliest_safe_memory, value.last_received_message);

                // If we haven't messaged our peers in a while send them a message
                // This lets them know nothing has happened and they can discard history.
                // I suspect the underlying RTCDataChannel protocol is sending keep alives as well,
                // it'd be better to figure out if those could be used instead.
                const KEEP_ALIVE_THRESHOLD = 200;
                if ((this._offline_tangle.current_time - value.last_sent_message) > KEEP_ALIVE_THRESHOLD) {
                    this._room.send_message(this._encode_time_progressed_message(this._offline_tangle.current_time), peer_id);
                }
            }

            // This -100 is for debugging purposes only
            this._offline_tangle.remove_history_before(earliest_safe_memory - 100);
        }

        this._last_performance_now = performance_now;
    }
    progress_time() {
        this._run_inner_function(async () => {
            await this._progress_time_inner();
        });
    }
}

