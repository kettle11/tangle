import { PeerId, Room, RoomState } from "./room.js";
import { TimeMachine, FunctionCall } from "./time_machine";
import { RustUtilities } from "./rust_utilities.js";
import { MessageWriterReader } from "./message_encoding.js";

export { RoomState, PeerId } from "./room.js";

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
    private _time_machine!: TimeMachine;
    private _rust_utilities: RustUtilities;

    private _buffered_messages: Array<FunctionCall> = [];
    private _peer_data: Map<PeerId, PeerData> = new Map();
    private _tangle_state = TangleState.Disconnected;
    private _current_program_binary = new Uint8Array();
    private _block_reentrancy = false;
    private _enqueued_inner_calls: Array<() => void> = [];
    private _last_performance_now?: number;
    private _configuration: TangleConfiguration = {};
    private _outgoing_message_buffer = new Uint8Array(500);

    private _message_time_offset = 0;

    // private _debug_enabled = true;

    static async setup(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, tangle_configuration?: TangleConfiguration): Promise<Tangle> {
        tangle_configuration ??= {};
        tangle_configuration.accept_new_programs ??= false;
        tangle_configuration.fixed_update_interval ??= 0;

        const time_machine = await TimeMachine.setup(wasm_binary, wasm_imports, tangle_configuration.fixed_update_interval);

        const tangle = new Tangle(time_machine);
        tangle._configuration = tangle_configuration;
        await tangle.setup_inner(time_machine, wasm_binary);
        return tangle;
    }

    constructor(time_machine: TimeMachine) {
        this._time_machine = time_machine;
        this._rust_utilities = time_machine.rust_utilities;
    }

    private _change_state(state: TangleState) {
        if (this._tangle_state != state) {
            this._tangle_state = state;
            this._configuration.on_state_change_callback?.(state, this);
        }
        this._tangle_state = state;
    }

    private async setup_inner(time_machine: TimeMachine, wasm_binary: Uint8Array) {
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

                    /*
                    time = ((this._time_machine.current_time + 1000) % 500) + this._offline_tangle.current_time;
                    if (time < this.earliest_safe_memory_time()) {
                        console.error("ERROR: POTENTIAL DESYNC DUE TO PEER LEAVING!");
                    }

                    const time_stamp = {
                        time,
                        player_id: 0 // 0 is for events sent by the server.
                    };

                    console.log("[tangle] calling 'peer_left'");
                    this._offline_tangle.call_with_time_stamp(time_stamp, "peer_left", [peer_id]);
                    */
                });
            },
            on_state_change: (state: RoomState) => {
                this._run_inner_function(async () => {
                    console.log("[tangle] Room state changed: ", RoomState[state]);

                    switch (state) {
                        case RoomState.Connected: {
                            this._request_heap();

                            if (this._peer_data.size == 0) {
                                // We have no peer so we're connected
                                this._change_state(TangleState.Connected);
                            }
                            break;
                        }
                        case RoomState.Disconnected: {
                            this._change_state(TangleState.Disconnected);
                            break;
                        }
                        case RoomState.Joining: {
                            this._change_state(TangleState.Disconnected);
                            break;
                        }
                    }

                });
            },
            on_message: async (peer_id: PeerId, message: Uint8Array) => {
                const peer_connected_already = this._peer_data.get(peer_id);

                const message_type = message[0];
                if (message_type == MessageType.WasmCall) {
                    const message_data = message.subarray(1);
                    const m = this._decode_wasm_call_message(message_data);
                    console.log("INCOMING WASM CALL HERE: ", this._time_machine.get_function_name(m.function_index));
                }

                this._run_inner_function(async () => {
                    // Ignore messages from peers that have disconnected. 
                    // TODO: Evaluate if this could cause desyncs.
                    const peer = this._peer_data.get(peer_id);
                    if (!peer) {
                        console.log("REJECTED MESSAGE FROM UNCONNECTED PEER: ", peer_id);
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

                            console.log("INCOMING WASM CALL: ", this._time_machine.get_function_name(m.function_index));

                            if (this._tangle_state == TangleState.RequestingHeap) {
                                this._buffered_messages.push({
                                    function_export_index: m.function_index,
                                    time_stamp: time_stamp,
                                    args: m.args
                                });
                            } else {
                                console.log("CALLING WASM: ", this._time_machine.get_function_name(m.function_index));
                                await this._time_machine.call_with_time_stamp(m.function_index, m.args, time_stamp);
                            }

                            break;
                        }
                        case (MessageType.RequestState): {
                            if (this._configuration?.accept_new_programs) {
                                // Also send the program binary.
                                const program_message = this._encode_new_program_message(this._current_program_binary);
                                this._room.send_message(program_message);
                            }

                            const heap_message = this._time_machine.encode(MessageType.SetHeap);
                            this._room.send_message(heap_message);
                            break;
                        }
                        case (MessageType.SetProgram): {
                            if (!this._configuration?.accept_new_programs) {
                                console.log("[tangle] Rejecting call to change programs");
                                return;
                            }

                            console.error("TODO: Set program");
                            /*
                            console.log("[tangle] Changing programs");

                            // TODO: This is incorrect. Make sure all peers are aware of their roundtrip average with each-other
                            const round_trip_time = peer.round_trip_time;
                            console.log("[tangle] Round trip offset: ", round_trip_time / 2);

                            const new_program = this._decode_new_program_message(message_data);
                            this._current_program_binary = new_program;
                            await this._time_machine.reset_with_new_program(new_program, (round_trip_time / 2));
                            */
                            break;
                        }
                        case (MessageType.SetHeap): {
                            console.log("[tangle] Applying TimeMachine state from peer");

                            const round_trip_time = peer.round_trip_time;
                            console.log("[tangle] Approximate round trip offset: ", round_trip_time / 2);
                            this._time_machine.decode_and_apply(new MessageWriterReader(message_data));

                            // Apply any messages that were received as we were waiting for this to load.
                            for (const m of this._buffered_messages) {
                                await this._time_machine.call_with_time_stamp(m.function_export_index, m.args, m.time_stamp,);
                            }
                            this._buffered_messages = [];

                            // Progress the target time to approximately catch up to the remote peer.
                            this._time_machine.progress_time(round_trip_time / 2);

                            this._change_state(TangleState.Connected);
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

        this._room = await Room.setup(room_configuration, this._rust_utilities);
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

    private _encode_wasm_call_message(function_index: number, time: number, args: Array<number> /*, hash?: Uint8Array*/): Uint8Array {
        const message_writer = new MessageWriterReader(this._outgoing_message_buffer);
        message_writer.write_u8(MessageType.WasmCall);

        message_writer.write_u32(function_index);
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

        return this._outgoing_message_buffer.subarray(0, message_writer.offset);
    }

    private _decode_wasm_call_message(data: Uint8Array) {
        const message_reader = new MessageWriterReader(data);

        const function_index = message_reader.read_u32();
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

        return {
            function_index,
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
        // TODO!
        /*
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
        */
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

            const time_stamp = {
                time: this._time_machine.target_time() + this._message_time_offset,
                player_id: this._room.my_id
            };

            // Ensure events each have a unique timestamp.
            // In practice this tiny offset should be of no consequence.
            this._message_time_offset += .0001;

            // Adding time delay here decreases responsivity but also decreases the likelihood
            // peers will have to rollback.
            // This could be a good place to add delay if a peer has higher latency than 
            // everyone else in the room.
            // Adding a time delay would look something like this:
            // time_stamp.time += 50;

            const function_index = this._time_machine.get_function_export_index(function_name);
            if (function_index !== undefined) {
                await this._time_machine.call_with_time_stamp(function_index, args_processed, time_stamp);

                // Network the call
                console.log("SENDING MESSAGE: ", function_name);
                this._room.send_message(this._encode_wasm_call_message(function_index, time_stamp.time, args_processed));

                for (const value of this._peer_data.values()) {
                    value.last_sent_message = Math.max(value.last_received_message, time_stamp.time);
                }
            }
        });
    }

    /// This call will have no impact but can be useful to draw or query from the world.
    call_and_revert(function_name: string, args: Array<number>) {
        this._run_inner_function(async () => {
            const args_processed = this._process_args(args);
            const function_index = this._time_machine.get_function_export_index(function_name);
            if (function_index) {
                this._time_machine.call_and_revert(function_index, args_processed);
            }
        });
    }

    /// Resync with the room, immediately catching up.
    resync() {
        this._run_inner_function(() => {
            this._request_heap();
        });
    }

    progress_time() {
        this._run_inner_function(async () => {
            await this._progress_time_inner();
        });
    }

    private async _progress_time_inner() {
        const performance_now = performance.now();

        if (this._last_performance_now) {
            this._message_time_offset = 0;

            const time_progressed = performance_now - this._last_performance_now;

            // TODO: Detect if we've fallen too far behind.
            // Detect if we've fallen behind and need to resynchronize with the room.
            // This likely occurs in scenarios where connections are a atrocious (in which case this might not be the right check)
            // or when a tab is suspended for a bit.
            /*
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
            */

            await this._time_machine.progress_time(time_progressed);

            const time_budget = time_progressed * 0.7;
            const time_here = performance.now();

            this._time_machine.take_snapshot();
            while (this._time_machine.step()) {
                // TODO: A better heuristic for when snapshots should be taken.
                // They could be taken after a set amount of computational overhead.
                this._time_machine.take_snapshot();
                if ((performance.now() - time_here) > time_budget) {
                    break;
                }
            }

            // Remove history that's safe to remove.

            // Keep track of when a message was received from each peer
            // and use that to determine what history is safe to throw away.
            let earliest_safe_memory = this._time_machine.current_simulation_time();
            for (const [peer_id, value] of this._peer_data) {
                earliest_safe_memory = Math.min(earliest_safe_memory, value.last_received_message);

                // If we haven't messaged our peers in a while send them a message
                // This lets them know nothing has happened and they can discard history.
                // I suspect the underlying RTCDataChannel protocol is sending keep alives as well,
                // it'd be better to figure out if those could be used instead.
                const KEEP_ALIVE_THRESHOLD = 200;
                const current_time = this._time_machine.target_time();
                if ((current_time - value.last_sent_message) > KEEP_ALIVE_THRESHOLD) {
                    this._room.send_message(this._encode_time_progressed_message(current_time), peer_id);
                }
            }

            // DEBUG: This -100 is for debugging purposes only
            this._time_machine.remove_history_before(earliest_safe_memory - 100);

        }

        this._last_performance_now = performance_now;
    }

    read_memory(address: number, length: number): Uint8Array {
        return this._time_machine.read_memory(address, length);
    }
    read_string(address: number, length: number): string {
        return this._time_machine.read_string(address, length);
    }
}

