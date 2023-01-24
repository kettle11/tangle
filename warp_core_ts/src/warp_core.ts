import { Room, RoomState } from "./room.js";
import { OfflineWarpCore, FunctionCall, arrayEquals } from "./offline_warp_core.js";

export { RoomState } from "./room.js";

type LoadingHeapMessage = {
    message_type: MessageType,
    heap_size: number,
    current_time: number,
    recurring_call_time: number,
    function_calls: Array<FunctionCall>
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

export class WarpCore {
    room!: Room;
    private _warp_core!: OfflineWarpCore;
    private _loading_heap?: Uint8Array = undefined;
    private _bytes_remaining_for_heap_load: number = 0;
    private _loading_heap_message?: LoadingHeapMessage = undefined;
    private _buffered_messages: Array<any> = [];
    private _peer_data: Map<string, PeerData> = new Map();

    static async setup(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, recurring_call_interval: number, on_state_change_callback?: (state: RoomState) => void): Promise<WarpCore> {
        let warp_core = new WarpCore();
        await warp_core.setup_inner(wasm_binary, wasm_imports, recurring_call_interval, on_state_change_callback);
        return warp_core;
    }

    private request_heap() {
        // Ask an arbitrary peer for the heap
        let lowest_latency_peer = this.room.get_lowest_latency_peer();
        if (lowest_latency_peer) {
            this.room.message_specific_peer(lowest_latency_peer, JSON.stringify({
                message_type: MessageType.RequestHeap,
            }));
        }
    }

    private send_heap(specific_peer?: string) {
        if (this._bytes_remaining_for_heap_load == 0) {
            let memory = this._warp_core.wasm_instance!.instance.exports.memory as WebAssembly.Memory;
            let encoded_data = this._warp_core.gzip_encode(new Uint8Array(memory.buffer));

            // TODO: This could be rather large as JSON, a more efficient encoding should be used.
            //  past_actions: actions,
            // TODO: Also send heap reads so that this can rollback.
            this.room.send_message(JSON.stringify({
                message_type: MessageType.SentHeap,
                heap_size: encoded_data.byteLength,
                current_time: this._warp_core.current_time,
                recurring_call_time: this._warp_core.recurring_call_time,
                function_calls: this._warp_core.function_calls
            }), specific_peer);

            const HEAP_CHUNK_SIZE = 16000; // 16kb
            for (let i = 0; i < encoded_data.byteLength; i += HEAP_CHUNK_SIZE) {
                this.room.send_message(new Uint8Array(encoded_data).slice(i, Math.min(i + HEAP_CHUNK_SIZE, encoded_data.byteLength)), specific_peer);
            }
        } else {
            console.error("Heap cannot be sent because it's not loaded yet");
        }
    }

    private async setup_inner(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, recurring_call_interval: number, on_state_change_callback?: (state: RoomState) => void) {
        let room_configuration = {
            on_peer_joined: (peer_id: string) => {
                this._peer_data.set(peer_id, {
                    last_sent_message: 0,
                    last_received_message: 0,
                });
            },
            on_peer_left: (peer_id: string) => {
                this._peer_data.delete(peer_id);
            },
            on_state_change: (state: RoomState) => {
                // TODO: Change this callback to have room passed in.

                console.log("[warpcore] Room state changed: ", RoomState[state]);

                if (state == RoomState.Connected) {
                    this.request_heap();
                }

                on_state_change_callback?.(state);
            },
            on_message: async (peer_id: string, message: any) => {
                // TODO: Handle the various message types here.
                let m = undefined;
                try {
                    m = JSON.parse(message);
                } catch (e) { }

                if (m) {
                    switch (m.message_type) {
                        case (MessageType.TimeProgressed): {
                            this._peer_data.get(peer_id)!.last_received_message = m.time;
                            break;
                        }
                        case (MessageType.WasmCall): {
                            this._peer_data.get(peer_id)!.last_received_message = m.time_stamp.time;

                            if (this._bytes_remaining_for_heap_load > 0) {
                                this._buffered_messages.push(message);
                            } else {
                                console.log("REMOTE CALL: ", m.function_name);

                                let requires_rollback = m.time_stamp.time < this._warp_core.recurring_call_time;
                                if (requires_rollback) {
                                    console.log("THIS WILL REQUIRE A ROLLBACK");
                                }
                                // Note: If this is negative the implementation of progress_time simply does nothing.
                                await this.progress_time(m.time_stamp.time - this._warp_core.current_time);

                                // TODO: Could this be reentrant if incoming messages aren't respecting the async-ness?
                                let _ = await this._warp_core.call_with_time_stamp(m.time_stamp, m.function_name, m.args);

                                /*
                                let hash_after;
                                if (this._warp_core.function_calls[new_function_call_index + 1]) {
                                    hash_after = this._warp_core.function_calls[new_function_call_index + 1].hash_before;
                                } else {
                                    hash_after = this._warp_core.hash();
                                }

                                if (!arrayEquals(Object.values(m.hash_after), hash_after)) {
                                    console.error("DESYNCED HASH!");
                                    console.log("MESSAGE HASH: ", m.hash_after);
                                    console.log("MY HASH: ", hash_after);
                                } else {
                                    if (requires_rollback) {
                                        console.log("SUCCESSFUL ROLLBACK");
                                    }
                                }
                                */
                            }
                            // TODO: Check if these are sent before the heap is loaded
                            break;
                        }
                        case (MessageType.RequestHeap): {
                            if (this._bytes_remaining_for_heap_load == 0) {
                                this.send_heap(peer_id);
                            } else {
                                console.error("Heap requested but it's not loaded yet");
                            }
                            break;
                        }
                        case (MessageType.SentHeap): {
                            this._peer_data.get(peer_id)!.last_received_message = m.current_time;

                            // This is the start of a heap load.
                            this._loading_heap = new Uint8Array(m.heap_size);
                            this._bytes_remaining_for_heap_load = m.heap_size;
                            this._loading_heap_message = m;
                            break;
                        }
                        case (MessageType.SetProgram): {
                            this._warp_core.reset_with_new_program(m.new_program);
                        }
                    }
                }
                else {
                    // If it's not JSON it must be binary heap data.

                    // TODO: Use a more robust message scheme. 

                    let message_data = new Uint8Array(message);
                    this._loading_heap!.set(message_data, this._loading_heap!.byteLength - this._bytes_remaining_for_heap_load);
                    this._bytes_remaining_for_heap_load -= message_data.byteLength;

                    if (this._bytes_remaining_for_heap_load == 0) {
                        let decoded_heap = this._warp_core.gzip_decode(this._loading_heap!);
                        this._loading_heap = undefined;

                        // TODO: Push forward current_time based on latency and last message received time.
                        await this._warp_core.reset_with_wasm_memory(
                            decoded_heap,
                            this._loading_heap_message!.current_time,
                            this._loading_heap_message!.recurring_call_time);

                        // Apply all messages that were delayed due to not being loaded yet.
                        for (message of this._buffered_messages) {
                            await this._warp_core.call_with_time_stamp(message.time_stamp, message.function_name, message.args);
                        }
                        this._buffered_messages = [];
                    }
                }

            }
        };
        this._warp_core = await OfflineWarpCore.setup(wasm_binary, wasm_imports, recurring_call_interval);
        this.room = await Room.setup(room_configuration);
    }

    async set_program(new_program: Uint8Array) {
        // TODO: This will break if events arrive after the program is changed.

        await this._warp_core.reset_with_new_program(
            new_program,
        );

        // TODO: This really shouldn't be JSON.
        // Send this new heap to all peers.
        this.room.broadcast(JSON.stringify({
            message_type: MessageType.SetProgram,
            new_program: new_program
        }));
    }

    async call(function_name: string, args: [number]) {
        if (this._bytes_remaining_for_heap_load == 0) {

            let time_stamp = this._warp_core.next_time_stamp();
            let new_function_call_index = await this._warp_core.call_with_time_stamp(time_stamp, function_name, args);

            /*
            let hash = null;
            if (this._warp_core.function_calls[new_function_call_index + 1]) {
                hash = this._warp_core.function_calls[new_function_call_index + 1].hash_before;
            } else {
                hash = this._warp_core.hash();
            }
            */

            // Network the call
            this.room.broadcast(JSON.stringify({
                message_type: MessageType.WasmCall,
                time_stamp: time_stamp,
                function_name: function_name,
                args: args,
                //hash_after: hash,
            }));

            for (let [_, value] of this._peer_data) {
                value.last_sent_message = Math.max(value.last_received_message, time_stamp.time);
            }
        }
    }

    /// This call will have no impact but can be useful to draw or query from the world.
    async call_and_revert(function_name: string, args: [number]) {
        if (this._bytes_remaining_for_heap_load == 0) {
            this._warp_core.call_and_revert(function_name, args);
        }
    }

    /// Resync with the room, immediately catching up.
    resync() {
        console.log("REQUESTING HEAP!");
        this.request_heap();
    }

    async progress_time(time_progressed: number) {
        // TODO: Check if too much time is being progressed and if so consider a catchup strategy
        // or consider just disconnecting and reconnecting.
        let steps_remaining = this._warp_core.steps_remaining(time_progressed);

        // TODO: Detect if we're falling behind and can't keep up.

        // If we've fallen too far behind resync and catchup.
        if (steps_remaining > 20 && this._peer_data.size > 0) {
            this.request_heap();
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
                    this.room.broadcast(JSON.stringify({
                        message_type: MessageType.TimeProgressed,
                        time: this._warp_core.current_time
                    }));
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

