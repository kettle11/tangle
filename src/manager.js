import room from './room.js';

const WASM_PAGE_SIZE = 65536;
const MessageTypeEnum = Object.freeze({ WASM_CALL: 1, REQUEST_HEAP: 2, SENT_HEAP: 3 })

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
    memory = result.instance.exports.memory;

    // For now there's only one wasm instance at a time
    let wasm_memory;
    let wasm_instance;
    let wasm_module;

    let function_calls = [];
    let actions = [];

    // Prepare the wasm module.
    let length = wasm_binary.byteLength;
    let pointer = result.instance.exports.reserve_space(length);

    const data_location = new Uint8Array(memory.buffer, pointer, length);
    data_location.set(new Uint8Array(wasm_binary));

    result.instance.exports.prepare_wasm();

    let output_ptr = result.instance.exports.get_output_ptr();
    let output_len = result.instance.exports.get_output_len();
    const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);

    imports_in.wasm_guardian = {
        on_store: function (location, size) {
            // console.log("on_store called: ", location, size);
            let old_value = new Uint8Array(new Uint8Array(wasm_memory.buffer, location, size));
            actions.push({ type: "store", location: location, old_value: old_value, time: current_time });
        },
        on_grow: function (pages) {
            // console.log("on_grow called: ", pages);
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

                let page_diff = (new_heap.byteLength - wasm_memory.buffer.byteLength) / WASM_PAGE_SIZE;
                if (page_diff > 0) {
                    wasm_memory.grow(page_diff);
                }

                new Uint8Array(wasm_memory.buffer).set(new_heap);
                new_heap = null;
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
                    await call_wasm_unnetworked(m.function_name, m.args, m.time);
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
                    room.message_specific_peer(peer_id, JSON.stringify({
                        message_type: MessageTypeEnum.SENT_HEAP,
                        heap_size: wasm_memory.buffer.byteLength,
                        time: current_time,
                        // TODO: This could be rather large as JSON, a more efficient encoding should be used.
                        past_actions: actions,
                    }));

                    console.log("HEAP SIZE: ", wasm_memory.buffer.byteLength);

                    const HEAP_CHUNK_SIZE = 16000; // 16kb
                    for (let i = 0; i < wasm_memory.buffer.byteLength; i += HEAP_CHUNK_SIZE) {
                        room.message_specific_peer(peer_id, new Uint8Array(wasm_memory.buffer).slice(i, Math.min(i + HEAP_CHUNK_SIZE, wasm_memory.buffer.byteLength)));
                    }
                } else {
                    console.error("FATAL ERROR: PEER IS REQUESTING HEAP BUT I DO NOT HAVE IT YET");
                }
            }
        }
    });

    async function recurring_calls_until(time) {
        // TODO: This does not correctly handle events that occur directly on a time stamp.
        let i = Math.floor(current_time / recurring_call_interval) + 1;
        let n = Math.floor(time / recurring_call_interval);

        for (; i <= n; i++) {
            current_time = i * recurring_call_interval;
            await call_wasm_unnetworked("fixed_update", [current_time], current_time, true);
        }
    }

    async function call_wasm_unnetworked(function_name, args, time, skip_recurring = false) {
        if (!skip_recurring) {
            await recurring_calls_until(time);
        }

        let v0 = function_calls.length;

        let i = function_calls.length;
        for (; i > 0; i--) {
            let call = function_calls[i - 1];
            if (call.time < time) {
                break;
            }

            // If this function call is identical to the last function call then
            // deduplicate it.
            // I'm not sure this is a good idea, there may be something better.
            if (call.time == time) {
                function arrayEquals(a, b) {
                    return Array.isArray(a) &&
                        Array.isArray(b) &&
                        a.length === b.length &&
                        a.every((val, index) => val === b[index]);
                }

                if (function_name == call.function_name && arrayEquals(call.args, args)) {
                    console.log("IDENTICAL FUNCTION CALL: %s %s", function_name, time);
                    return;
                }

            }
        }

        let v1 = function_calls.length;

        // Undo everything that ocurred after this event.
        // TODO: Detect if this event has occurred too far in the past and should be ignored.
        await rewind(time);

        let v2 = function_calls.length;

        current_time = time;

        let actions_count = actions.length;
        let result = wasm_instance.exports[function_name](...args);

        let something_changed = actions_count != actions.length;

        // Only record this function_call if something actually changed.
        if (something_changed) {
            // console.log("RECORDING FUNCTION CALL WITH TIME: ", function_name, time);
            function_calls.splice(i, 0, { function_name: function_name, args: args, time: time });
        }

        // Replay all function calls that occur after this event.
        for (let j = i + 1; j < function_calls.length; j++) {
            let call = function_calls[j];
            console.log("REPLAYING FUNCTION CALL: %s %s", call.function_name, call.time);
            current_time = call.current_time;
            wasm_instance.exports[call.function_name](...call.args)
        }

        current_time = time;

        // Only issue on `up_update` event if this actually changed something.
        if (something_changed) {
            on_update();
        }

        return { result: result, something_changed: something_changed };
    }

    async function rewind(timestamp) {
        while (actions.at(-1) && actions.at(-1).time > timestamp) {
            let popped_action = actions.pop();

            switch (popped_action.type) {
                case "store":
                    console.log("REVERSING STORE");

                    let destination = new Uint8Array(wasm_memory.buffer, popped_action.location, popped_action.old_value.byteLength);
                    destination.set(popped_action.old_value);
                    break;
                case "grow":
                    console.log("REVERSING GROW");
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
                    console.log("REVERSING GLOBAL SET");

                    wasm_instance.exports[popped_action.global_id].value = popped_action.old_value;
                    break;
            }
        }
    }

    return {
        call_wasm_unnetworked: async function (function_name, args, time) {
            return await call_wasm_unnetworked(function_name, args, time).result;
        },
        call_wasm: async function (function_name, args, time) {
            let result = await call_wasm_unnetworked(function_name, args, time);

            // Only network this call if it resulted in persistent changes.
            if (result.something_changed) {
                // Network this call
                // TODO: More efficient encoding
                room.broadcast(JSON.stringify(({
                    message_type: MessageTypeEnum.WASM_CALL,
                    function_name: function_name,
                    time: time,
                    args: args
                })));
            }

            return result;
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

            function_calls.splice(step, function_calls.length);

        }
    };
}
