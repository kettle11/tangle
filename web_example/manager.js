import room from './room.js';

const WASM_PAGE_SIZE = 65536;
const MessageTypeEnum = Object.freeze({ WASM_CALL: 1, REQUEST_HEAP: 2, SENT_HEAP: 3, PAUSE_AT_TIME: 4, UNPAUSE: 5 })

/*
function arrayEquals(a, b) {
    return Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((val, index) => val === b[index]);
}
*/


function arrayEquals(a, b) {
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



export async function getWarpCore(wasm_binary, imports_in, recurring_call_interval, on_load = (time_of_heap_load) => { }, on_update = () => { }) {
    let current_time = 0;

    let memory;
    const decoder = new TextDecoder();

    console.log("GETTING WARP CORE");
    let imports = {
        env: {
            external_log: function (pointer, length) {
                const message_data = new Uint8Array(memory.buffer, pointer, length);
                const decoded_string = decoder.decode(new Uint8Array(message_data));
                console.log(decoded_string);
            },
            external_error: function (pointer, length) {
                const message_data = new Uint8Array(memory.buffer, pointer, length);
                const decoded_string = decoder.decode(new Uint8Array(message_data));
                console.error(decoded_string);
            }
        }
    };

    // Use the wasm_guardian Wasm binary to modify the passed in Wasm binary.
    let result = await WebAssembly.instantiateStreaming(fetch("warpcore_mvp.wasm"), imports);
    let warp_core_wasm_exports = result.instance.exports;
    memory = result.instance.exports.memory;

    // For now there's only one wasm instance at a time
    let wasm_memory;
    let wasm_instance;
    let wasm_module;

    let function_calls = [];
    let actions = [];

    let paused = false;

    let desync_debug_mode = true;

    // Prepare the wasm module.
    let length = wasm_binary.byteLength;
    let pointer = warp_core_wasm_exports.reserve_space(length);

    const data_location = new Uint8Array(memory.buffer, pointer, length);
    data_location.set(new Uint8Array(wasm_binary));
    warp_core_wasm_exports.prepare_wasm();

    let output_ptr = warp_core_wasm_exports.get_output_ptr();
    let output_len = warp_core_wasm_exports.get_output_len();
    const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);

    function gzip_encode(data_to_compress) {
        let pointer = warp_core_wasm_exports.reserve_space(data_to_compress.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_compress.byteLength);
        destination.set(new Uint8Array(data_to_compress));

        warp_core_wasm_exports.gzip_encode();
        let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        console.log("COMPRESSED LENGTH: ", result_data.byteLength);
        console.log("COMPRESSION RATIO: ", data_to_compress.byteLength / result_data.byteLength);
        return result_data;
    }

    function gzip_decode(data_to_decode) {
        let pointer = warp_core_wasm_exports.reserve_space(data_to_decode.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_decode.byteLength);
        destination.set(new Uint8Array(data_to_decode));

        warp_core_wasm_exports.gzip_decode();
        let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
        let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
        return result_data;
    }

    function xxh3_128_bit_hash(data_to_hash) {
        let pointer = warp_core_wasm_exports.reserve_space(data_to_hash.byteLength);
        const destination = new Uint8Array(memory.buffer, pointer, data_to_hash.byteLength);
        destination.set(new Uint8Array(data_to_hash));

        warp_core_wasm_exports.xxh3_128_bit_hash();
        let hashed_result = new Uint8Array(new Uint8Array(memory.buffer, pointer, 16));
        return hashed_result;
    }

    async function reset_to(time) {
        current_time = time;
        await rewind(time);

        // Remove function calls that happened after this time.
        let i = function_calls.length;
        for (; i > 0; i--) {
            if (function_calls[i - 1].time < time) {
                break;
            }
        }
        function_calls.splice(i, function_calls.length - i);

        if (function_calls.length > 0) {
            current_time = function_calls[function_calls.length - 1].time;
        }
    }


    imports_in.wasm_guardian = {
        on_store: function (location, size) {
            if (location > wasm_memory.buffer.byteLength) {
                console.error("OUT OF BOUNDS MEMORY WRITE");
            }
            // console.log("on_store called: ", location, size);
            let old_value = new Uint8Array(new Uint8Array(wasm_memory.buffer, location, size));

            actions.push({ type: "store", location: location, old_value: old_value, time: current_time, /* hash: new Uint8Array(xxh3_128_bit_hash(wasm_memory.buffer))*/ });
        },
        on_grow: function (pages) {
            console.log("on_grow called: ", pages);
            actions.push({ type: "grow", old_pages: wasm_memory.buffer.byteLength / WASM_PAGE_SIZE, time: current_time });
        },
        on_global_set: function (id) {
            // console.log("on_global_set called: ", id);
            let global_id = "wg_global_" + id;
            actions.push({ type: "global_set", global_id: global_id, old_value: wasm_instance.exports[global_id], time: current_time });
        },
    };

    await WebAssembly.instantiate(output_wasm, imports_in).then(result => {
        actions = [];
        wasm_memory = result.instance.exports.memory;
        wasm_instance = result.instance;
        wasm_module = result.module;

        console.log("INSTANTIATED INSTANCE: ", result.instance);
    });

    // Setup the networked room

    let heap_bytes_remaining = 0;
    let new_heap = null;
    let new_heap_offset = 0;
    let loaded_heap = true;
    let time_of_heap_load = 0;

    const peers = new Set();

    // Track when the last message from a peer was received.
    const peer_last_received_message_time = {};

    let peer_requesting_heap_from;

    let function_calls_for_after_loading = [];

    room.setup(() => {
        console.log("CONNECTED TO ROOM. Next: Request the heap")

        // Message an arbitrary peer to ask it for the heap.
        if (peers.size > 0) {
            // TODO: Handle the case where the peer is also still loading.
            // It will need to respond to indicate that and this peer will need to ask 
            // another peer for the heap.
            let p = Array.from(peers);
            peer_requesting_heap_from = p[0];
            room.message_specific_peer(p[0], JSON.stringify({
                message_type: MessageTypeEnum.REQUEST_HEAP,
            }));
        } else {
            current_time = Date.now();
            on_load(current_time);
        }
    }, () => {
        console.log("DISCONNECTED FROM ROOM");
    }, (peer_id, welcoming) => {
        // on_peer_joined
        peers.add(peer_id);
        peer_last_received_message_time[peer_id] = 0;
    }, (peer_id) => {
        // on_peer_left
        peers.delete(peer_id);
        delete peer_last_received_message_time[peer_id];
    }, async (message, peer_id) => {
        // on_message_received

        // If we're loading a multi-part heap from a peer.
        if (peer_requesting_heap_from === peer_id && heap_bytes_remaining > 0) {
            heap_bytes_remaining -= message.byteLength;

            let m = new Uint8Array(message);

            // TODO: This could instead be copied to the final heap instead of an intermediate heap.

            new_heap.set(m, new_heap_offset);
            new_heap_offset += message.byteLength;

            if (heap_bytes_remaining == 0) {
                console.log("RECEIVED HEAP");

                // Reset state tracking.

                function_calls = [];
                actions = [];

                let decoded_heap = gzip_decode(new_heap);
                new_heap = null;

                let page_diff = (decoded_heap.byteLength - wasm_memory.buffer.byteLength) / WASM_PAGE_SIZE;
                if (page_diff > 0) {
                    wasm_memory.grow(page_diff);
                }

                new Uint8Array(wasm_memory.buffer).set(decoded_heap);
                loaded_heap = true;

                for (let i = 0; i < function_calls_for_after_loading.length; i++) {
                    console.log("WASM CALL AFTER LOADING");

                    let m = function_calls_for_after_loading[i];

                    // Some of these actions may cause rollbacks.
                    await call_wasm_unnetworked(m.function_name, m.args, m.time);
                }

                // TODO: Is this correct
                current_time = time_of_heap_load;
                on_load(time_of_heap_load);
            }
        } else {
            let m = JSON.parse(message);

            if (m.message_type == MessageTypeEnum.WASM_CALL) {
                peer_last_received_message_time[peer_id] = peer_last_received_message_time;

                if (loaded_heap) {
                    console.log("MESSAGE RECEIVED: ", m);
                    if (function_calls.length > 0) {
                        console.log("RELATION TO MOST RECENT FUNCTION TIME: ", m.time - function_calls[function_calls.length - 1].time);
                    }
                    await call_wasm_unnetworked(m.function_name, m.args, m.time);

                    if (desync_debug_mode) {
                        let hash = xxh3_128_bit_hash(wasm_memory.buffer);
                        console.log("HASH AFTER NETWORKED MESSAGE %s:", m.function_name);
                        console.log(hash);
                        let hash_after = Object.values(m.hash_after);
                        if (!arrayEquals(hash, hash_after)) {
                            console.error("HASHES DO NOT MATCH!");
                            console.log(hash_after);
                            console.log(structuredClone(function_calls));
                        }
                    }

                } else {
                    console.log("DEFERRING WASM CALL UNTIL LOAD IS DONE: ", m);
                    function_calls_for_after_loading.push(m);
                }
            } else if (m.message_type == MessageTypeEnum.SENT_HEAP) {
                console.log("BEGINNING HEAP LOAD");
                heap_bytes_remaining = m.heap_size;
                new_heap_offset = 0;
                console.log("HEAP BYTES REMAINING: ", heap_bytes_remaining);

                new_heap = new Uint8Array(m.heap_size);

                actions = m.actions;
                time_of_heap_load = m.time;
            } else if (m.message_type == MessageTypeEnum.REQUEST_HEAP) {
                // TODO: This could be an unloaded peer.
                // That should be avoided somehow.
                if (loaded_heap) {
                    let encoded_data = gzip_encode(wasm_memory.buffer);
                    console.log("HEAP SIZE: ", wasm_memory.buffer.byteLength);
                    console.log("COMPRESSED HEAP SIZE: ", encoded_data.byteLength);

                    room.message_specific_peer(peer_id, JSON.stringify({
                        message_type: MessageTypeEnum.SENT_HEAP,
                        heap_size: encoded_data.byteLength,
                        time: current_time,
                        // TODO: This could be rather large as JSON, a more efficient encoding should be used.
                        //  past_actions: actions,
                    }));

                    const HEAP_CHUNK_SIZE = 16000; // 16kb
                    for (let i = 0; i < encoded_data.byteLength; i += HEAP_CHUNK_SIZE) {
                        room.message_specific_peer(peer_id, new Uint8Array(encoded_data).slice(i, Math.min(i + HEAP_CHUNK_SIZE, encoded_data.byteLength)));
                    }
                } else {
                    console.error("FATAL ERROR: PEER IS REQUESTING HEAP BUT I DO NOT HAVE IT YET");
                }
            } else if (m.message_type == MessageTypeEnum.PAUSE_AT_TIME) {
                console.log("PAUSING AT TIME: ", m.time);
                // Rollback to this time.
                // TODO: Check that we still can pause at this time.
                paused = true;
                reset_to(m.time);
            } else if (m.message_type == MessageTypeEnum.UNPAUSE) {
                paused = false;
            }
        }
    });

    let last_start = 0;
    async function recurring_calls_until(time) {
        // console.log("CURRENT TIME: ", current_time);
        // console.log("TIME: ", time);

        // TODO: This does not correctly handle events that occur directly on a time stamp.
        let i = Math.ceil((current_time + 1) / recurring_call_interval);
        let n = Math.floor(time / recurring_call_interval);

        if ((n - i) > 2) {
            console.log("RECURRING CALLS TO PERFORM: ", n - i);
            console.log("TIME DELTA: ", time - current_time);
        }

        // TODO: Rework recurring_calls to have a better time fix.
        if (i == last_start) {
            i += 1;
        }

        last_start = i;
        //  console.log("I: ", i);
        //  console.log("N: ", n);
        for (; i <= n; i++) {
            current_time = i * recurring_call_interval;
            if (function_calls.length > 0 && current_time - function_calls[function_calls.length - 1].time > 17) {
                console.log("THIS SHOULD NOT HAPPEN");
            }
            await call_wasm_unnetworked("fixed_update", [current_time], current_time, true);
        }
    }

    function function_call_less_than(a, b) {
        if (a.time < b.time) {
            return true;
        }

        if (a.is_recurring && !b.is_recurring) {
            return true;
        }

        if (a.function_name < b.function_name) {
            return true;
        }

        if (a.function_name == b.function_name) {
            console.error("UNHANDLED CASE!");
            console.log(a);
            console.log(b);
        }

        return false;
    }

    async function progress_time(time, skip_recurring) {
        if (paused && time > current_time) {
            return { result: null, something_changed: false };
        }

        if (function_calls.length > 0 && time < function_calls[function_calls.length - 1].time) {
            console.log("FUNCTION TIME THAT IS LESS THAN PREVIOUS LAST ONE");
        }

        if (!skip_recurring && recurring_call_interval != 0) {
            await recurring_calls_until(time);
        }
        current_time = time;
    }

    async function call_wasm_unnetworked(function_name, args, time, skip_recurring = false) {
        if (!skip_recurring) {
            await progress_time(time, skip_recurring);
        }

        let function_call = { function_name: function_name, args: args, time: time, is_recurring: skip_recurring };

        let i = function_calls.length;
        for (; i > 0; i--) {
            if (function_call_less_than(function_calls[i - 1], function_call)) {
                break;
            }
        }

        // Undo everything that ocurred after this event.
        // TODO: Detect if this event has occurred too far in the past and should be ignored.
        await rewind(time);

        // console.log("HASH HERE 9: ", xxh3_128_bit_hash(wasm_memory.buffer));

        //console.log("HEAP HASH AFTER REWIND: ", xxh3_128_bit_hash(wasm_memory.buffer));

        current_time = time;

        let actions_count = actions.length;

        // Perform the action
        let result = wasm_instance.exports[function_name](...args);

        if (desync_debug_mode) {
            function_call.hash = xxh3_128_bit_hash(wasm_memory.buffer);
        }
        // DEBUG REWIND
        // await rewind(time - 1);
        // console.log("HASH HERE 10: ", xxh3_128_bit_hash(wasm_memory.buffer));


        let something_changed = actions_count != actions.length;

        // Only record this function_call if something actually changed.
        if (something_changed) {
            // console.log("RECORDING FUNCTION CALL WITH TIME: ", function_name, time);
            function_calls.splice(i, 0, function_call);
            i += 1;
        }

        // Replay all function calls that occur after this event.
        for (let j = i; j < function_calls.length; j++) {
            let call = function_calls[j];
            console.log("REPLAYING FUNCTION CALL: %s %s", call.function_name, call.time);
            current_time = call.time;
            wasm_instance.exports[call.function_name](...call.args)
        }

        // Only issue on `up_update` event if this actually changed something.
        if (something_changed) {
            on_update();
        }

        //console.log("HEAP HASH AFTER ACTION: ", xxh3_128_bit_hash(wasm_memory.buffer));

        return { result: result, something_changed: something_changed };
    }

    async function rewind(timestamp) {
        while (actions[actions.length - 1] && actions[actions.length - 1].time > timestamp) {
            let popped_action = actions.pop();
            //console.log("REWINDING: ", popped_action);

            switch (popped_action.type) {
                case "store":
                    // console.log("REVERSING STORE");

                    let destination = new Uint8Array(wasm_memory.buffer, popped_action.location, popped_action.old_value.byteLength);
                    destination.set(popped_action.old_value);

                    /*
                    let hash = xxh3_128_bit_hash(wasm_memory.buffer);
    
                    if (!arrayEquals(popped_action.hash, hash)) {
                        console.log("NOT MATCHING ROLLBACK");
                    } else {
                        console.log("MATCHING ROLLBACK");
                    }
                    */
                    break;
                case "grow":
                    // console.log("REVERSING GROW");
                    // The only way to "shrink" a Wasm instance is to construct an entirely new 
                    // one with a new memory.
                    // Hopefully Wasm gets a better way to shrink modules in the future.

                    let new_memory = new WebAssembly.Memory({
                        initial: popped_action.old_pages
                    });

                    let dest = new Uint8Array(new_memory.buffer);
                    dest.set(wasm_memory.buffer.slice(new_memory.buffer.byteLength));
                    imports_in.mem = new_memory;

                    await WebAssembly.instantiate(wasm_module, imports_in).then(r => {
                        wasm_memory = r.exports.memory;
                        wasm_instance = r;
                    });

                    break;
                case "global_set":
                    // console.log("REVERSING GLOBAL SET");

                    wasm_instance.exports[popped_action.global_id].value = popped_action.old_value;
                    break;
            }
        }
    }

    return {
        call_wasm_unnetworked: async function (function_name, args, time) {
            let result = await call_wasm_unnetworked(function_name, args, time);
            return result;
        },
        call_wasm: async function (function_name, args, time) {
            window.last_wasm_sent_time = time;

            if (desync_debug_mode) {
                let hash = xxh3_128_bit_hash(wasm_memory.buffer);
                console.log("HASH PRIOR TO CALL: ", hash);
            }

            let result = await call_wasm_unnetworked(function_name, args, time);

            // Only network this call if it resulted in persistent changes.
            if (result.something_changed) {
                let message = {
                    message_type: MessageTypeEnum.WASM_CALL,
                    function_name: function_name,
                    time: time,
                    args: args,
                };

                if (desync_debug_mode) {
                    let hash = xxh3_128_bit_hash(wasm_memory.buffer);
                    message.hash_after = hash;
                    console.log("HASH AFTER WASM CALL %s:", function_name);
                    console.log(hash);
                    console.log(structuredClone(function_calls));
                }

                // Network this call
                // TODO: More efficient encoding
                room.broadcast(JSON.stringify(message));
            }

            return result.result;
        },
        call_wasm_unnetworked_and_rollback: async function (function_name, args, time) {
            // TODO: There's an unhandled edge case where where the time is equivalent to 
            // an existing time. 
            // This shouldn't rollback fixed updates that occur as a result of time progressing.
            let result = await call_wasm_unnetworked(function_name, args, time);
            reset_to(time - 1);

            return result;
        },
        progress_time: async function (curent_time) {
            await progress_time(curent_time);
        },
        log_hash: function () {
            // TODO: This does not include Wasm global values.
            console.log("HEAP HASH: ", xxh3_128_bit_hash(wasm_memory.buffer));
        },
        log_function_calls: async function () {
            console.log(structuredClone(function_calls));
        },
        rewind: async function (time) {
            await rewind(time);
        },
        toggle_pause: function (time) {
            paused = !paused;
            if (paused) {
                room.broadcast(JSON.stringify(({
                    message_type: MessageTypeEnum.PAUSE_AT_TIME,
                    time: time,
                })));
            } else {
                room.broadcast(JSON.stringify(({
                    message_type: MessageTypeEnum.UNPAUSE,
                })));
            }
        },
        is_paused: function () {
            return paused;
        },
        remove_history: function (timestamp) {
            let step = 0;
            for (; step < actions.length; step++) {
                if (actions[step].time >= timestamp) {
                    break;
                }
            }

            // Remove all the elements that were before this.
            actions.splice(step, actions.length);
            // console.log("REMOVING HISTORY. NEW LENGTH: ", actions.length);

            step = 0;
            for (; step < function_calls.length; step++) {
                if (function_calls[step].time >= timestamp) {
                    break;
                }
            }

            //function_calls.splice(step, function_calls.length);
        }
    };
}
