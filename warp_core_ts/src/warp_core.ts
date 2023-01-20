import { Room, RoomState } from "./room.js";
import { OfflineWarpCore, FunctionCall } from "./offline_warp_core.js";

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
}

export class WarpCore {
    room!: Room;
    private _warp_core!: OfflineWarpCore;
    private _loading_heap?: Uint8Array = undefined;
    private _bytes_remaining_for_heap_load: number = 0;
    private _loading_heap_message?: LoadingHeapMessage = undefined;
    private _buffered_messages: Array<any> = [];

    private static async setup(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, recurring_call_interval: number, on_state_change_callback?: (state: RoomState) => void): Promise<WarpCore> {
        let warp_core = new WarpCore();
        await warp_core.setup_inner(wasm_binary, wasm_imports, recurring_call_interval, on_state_change_callback);
        return warp_core;
    }

    private async setup_inner(wasm_binary: Uint8Array, wasm_imports: WebAssembly.Imports, recurring_call_interval: number, on_state_change_callback?: (state: RoomState) => void) {
        let room_configuration = {
            on_state_change: (state: RoomState) => {
                // TODO: Change this callback to have room passed in.

                console.log("[warpcore] Room state changed: ", RoomState[state]);

                if (state == RoomState.Connected) {
                    // Ask an arbitrary peer for the heap
                    let lowest_latency_peer = this.room.get_lowest_latency_peer();
                    if (lowest_latency_peer) {
                        this.room.message_specific_peer(lowest_latency_peer, JSON.stringify({
                            message_type: MessageType.RequestHeap,
                        }));
                    }
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
                        case (MessageType.WasmCall): {
                            if (this._bytes_remaining_for_heap_load > 0) {
                                this._buffered_messages.push(message);
                            } else {
                                // Note: If this is negative the implementation of progress_time simply does nothing.
                                await this.progress_time(m.time_stamp.time - this._warp_core.current_time);

                                // TODO: Could this be reentrant if incoming messages aren't respecting the async-ness?
                                await this._warp_core.call_with_time_stamp(m.time_stamp, m.function_name, m.args);
                            }
                            // TODO: Check if these are sent before the heap is loaded
                            break;
                        }
                        case (MessageType.RequestHeap): {
                            if (this._bytes_remaining_for_heap_load == 0) {
                                let memory = this._warp_core.wasm_instance!.instance.exports.memory as WebAssembly.Memory;
                                let encoded_data = this._warp_core.gzip_encode(new Uint8Array(memory.buffer));

                                // TODO: This could be rather large as JSON, a more efficient encoding should be used.
                                //  past_actions: actions,
                                // TODO: Also send heap reads so that this can rollback.
                                this.room.message_specific_peer(peer_id, JSON.stringify({
                                    message_type: MessageType.SentHeap,
                                    heap_size: encoded_data.byteLength,
                                    current_time: this._warp_core.current_time,
                                    recurring_call_time: this._warp_core.recurring_call_time,
                                    function_calls: this._warp_core.function_calls
                                }));

                                const HEAP_CHUNK_SIZE = 16000; // 16kb
                                for (let i = 0; i < encoded_data.byteLength; i += HEAP_CHUNK_SIZE) {
                                    this.room.message_specific_peer(peer_id, new Uint8Array(encoded_data).slice(i, Math.min(i + HEAP_CHUNK_SIZE, encoded_data.byteLength)));
                                }
                            } else {
                                console.error("Heap requested but it's not loaded yet");
                            }
                            break;
                        }
                        case (MessageType.SentHeap): {
                            // This is the start of a heap load.
                            this._loading_heap = new Uint8Array(m.heap_size);
                            this._bytes_remaining_for_heap_load = m.heap_size;
                            this._loading_heap_message = m;
                            break;
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

    async call(function_name: string, args: [number]) {
        if (this._bytes_remaining_for_heap_load == 0) {

            let time_stamp = this._warp_core.next_time_stamp();
            this._warp_core.call_with_time_stamp(time_stamp, function_name, args);

            // Network the call
            this.room.broadcast(JSON.stringify({
                message_type: MessageType.WasmCall,
                time_stamp: time_stamp,
                function_name: function_name,
                args: args,
            }));

            console.log("HASH HERE: ", this._warp_core.hash());
        }
    }

    /// This call will have no impact but can be useful to draw or query from the world.
    async call_and_revert(function_name: string, args: [number]) {
        if (this._bytes_remaining_for_heap_load == 0) {
            this._warp_core.call_and_revert(function_name, args);
        }
    }

    async progress_time(time_progressed: number) {
        // TODO: Chcek if too much time is being progressed and if so consider a catchup strategy
        // or consider just disconnecting and reconnecting.
        this._warp_core.progress_time(time_progressed);
    }

    // TODO: Don't expose this and instead remove history when there's no chance of a rollback.
    remove_history_before(time_exclusive: number) {
        this._warp_core.remove_history_before(time_exclusive);
    }

    get_memory(): WebAssembly.Memory {
        return this._warp_core.wasm_instance?.instance.exports.memory as WebAssembly.Memory;
    }
}

