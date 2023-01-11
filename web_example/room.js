const StateEnum = Object.freeze({ JOINING: 1, DISCONNECTED: 2, CONNECTED: 3 })

let server_socket;

let peer_connections = {};
let current_room_name = document.location.hash.substring(1);
// This is relevant when joining a room.
let peers_to_join = {};
let current_state = StateEnum.DISCONNECTED;

let room = {
    setup(on_connected, on_disconnected, on_peer_joined, on_peer_left, on_message) {
        if (!server_socket) {
            server_socket = new WebSocket("ws://0.0.0.0:8081");
        }
        function check_if_joined() {
            if (current_state == StateEnum.JOINING && peers_to_join.size == 0) {
                current_state = StateEnum.CONNECTED;
                on_connected();
            }
        }

        function remove_peer(peer_id) {
            if (peer_connections[peer_id]) {
                console.log("REMOVING PEER: ", peer_id);
                peer_connections[peer_id].close();
                delete peer_connections[peer_id];
                console.log("NUMBER OF PEERS", peer_connections.length);

                on_peer_left(peer_id);
            }
        }


        console.log("SETTING UP ROOM");

        if (server_socket.readyState == 1) {
            console.log("[open] Connection established");
            console.log("Sending to server");
            server_socket.send(JSON.stringify({ 'join_room': document.location.hash.substring(1) }));
        } else {
            server_socket.onopen = async function (e) {
                console.log("[open] Connection established");
                console.log("Sending to server");
                server_socket.send(JSON.stringify({ 'join_room': document.location.hash.substring(1) }));
            };
        }

        onhashchange = (event) => {
            if (current_room_name != document.location.hash.substring(1)) {
                location.reload();
                current_room_name = document.location.hash.substring(1);
            }
        };

        function make_rtc_peer_connection(peer_id, welcoming) {
            var SERVERS = [
                { urls: "stun:stun1.l.google.com:19302" },
            ];
            const configuration = { 'iceServers': SERVERS };
            const peer_connection = new RTCPeerConnection(configuration);

            // TODO: If this is swapped to a more unreliable UDP-like protocol then ordered and maxRetransmits should be set to false and 0.
            // maxRetransmits: null is meant to be the default but explicitly setting it seems to trigger a Chrome
            // bug where some packets are dropped.
            // TODO: Report this bug.
            const channel = peer_connection.createDataChannel("sendChannel", { negotiated: true, id: 2, ordered: true });
            peer_connection.data_channel = channel;

            peer_connection.onicecandidate = event => {
                console.log("NEW ICE CANDIDATE: ", event.candidate);
                if (event.candidate) {
                    console.log(JSON.stringify({ 'new_ice_candidate': event.candidate, 'destination': peer_id }));
                    server_socket.send(JSON.stringify({ 'new_ice_candidate': event.candidate, 'destination': peer_id }));
                }
            };
            peer_connection.onicecandidateerror = event => {
                console.log("ICE CANDIDATE ERROR: ", event);
            };

            peer_connection.onnegotiationneeded = async (ev) => {
                console.log("NEGOTIATION NEEDED");
                const offer = await peer_connection.createOffer();
                await peer_connection.setLocalDescription(offer);
                server_socket.send(JSON.stringify({ 'offer': offer, 'destination': peer_id }));
            };

            peer_connection.onsignalingstatechange = async (ev) => {
                console.log("SIGNALING STATE CHANGED: ", peer_connection.signalingState)
            };

            peer_connection.onconnectionstatechange = async (ev) => {
                console.log("CONNECTION STATE CHANGED: ", peer_connection.connectionState)
            };

            peer_connection.data_channel.onopen = event => {
                peer_connection.getStats(null).then((stats) => {
                    console.log("DATA CHANNEL STATS: ");
                    console.log(stats);
                    stats.forEach((report) => {
                        if (report.type === "candidate-pair") {
                            console.log("ROUND TRIP TIME SECONDS TO PEER: %s : %s", peer_id, report.currentRoundTripTime);
                        }
                    });
                    peers_to_join.delete(peer_id);
                    on_peer_joined(peer_id, welcoming);
                    check_if_joined();
                });
            }

            peer_connection.data_channel.onclose = event => {
                remove_peer(peer_id);
            }

            peer_connection.data_channel.onmessage = (event) => {
                // Call the user provided callback
                on_message(event.data, peer_id);
            }

            peer_connections[peer_id] = peer_connection;
            console.log("NUMBER OF PEERS", Object.keys(peer_connections).length);

            return peer_connection;
        }

        server_socket.onmessage = async function (event) {
            let last_index = event.data.lastIndexOf('}');
            let json = event.data.substring(0, last_index + 1);

            let message = JSON.parse(json);
            // peer_id is appended by the server to the end of incoming messages.
            let peer_id = event.data.substring(last_index + 1).trim();

            // Received when joining a room for the first time.
            if (message.room_name) {
                current_state = StateEnum.JOINING;

                console.log("I AM JOINING ROOM: ", message.room_name);
                console.log("PEERS TO JOIN: ", message.peers);
                peers_to_join = new Set(message.peers);

                for (const [key, value] of Object.entries(peer_connections)) {
                    peers_to_join.delete(key);
                }
                check_if_joined();

                document.location =
                    document.location.origin.toString() +
                    '#' + message.room_name;
                current_room_name = message.room_name;
            }

            // Received when a new peer joins a room.
            if (message.join_room) {
                console.log("PEER JOINING ROOM");
                make_rtc_peer_connection(peer_id, true);
                console.log("ADDING PEER: ", peer_id);
            }

            // Received per-peer when connecting to a room
            if (message.offer) {
                console.log("RECEIVED OFFER");

                let peer_connection = make_rtc_peer_connection(peer_id, false);

                await peer_connection.setRemoteDescription(new RTCSessionDescription(message.offer));
                const answer = await peer_connection.createAnswer();
                await peer_connection.setLocalDescription(answer);

                server_socket.send(JSON.stringify({ 'answer': answer, 'destination': peer_id }));

                console.log("ADDING PEER: ", peer_id);
            }

            // Received when a new peer confirms their connection
            // The connection is finalized!
            if (message.answer) {
                console.log("RECEIVED ANSWER");
                let peer_connection = peer_connections[peer_id];

                const remoteDesc = new RTCSessionDescription(message.answer);
                await peer_connection.setRemoteDescription(remoteDesc);
            }

            // Received as connection settings are negotiated. 
            if (message.new_ice_candidate) {
                console.log("RECEIVED ICE CANDIDATE: ", message.new_ice_candidate);

                let peer_connection = peer_connections[peer_id];

                try {
                    await peer_connection.addIceCandidate(message.new_ice_candidate);
                } catch (e) {
                    console.error('Error adding received ice candidate', e);
                }
            }

            // Received when a peer leaves the room
            if (message.disconnected_peer_id) {
                peers_to_join.delete(message.disconnected_peer_id);
                check_if_joined();
                console.log("MESSAGE FROM SERVER: PEER LEFT: ", message.disconnected_peer_id);
                remove_peer(message.disconnected_peer_id);

            }

        };

        server_socket.onclose = function (event) {
            // Disconnecting from the WebSocket is considered a full disconnect from the room.

            on_disconnected();
            current_state = StateEnum.DISCONNECTED;
            peers_to_join = {};
            peer_connections = {};

            if (event.wasClean) {
                console.log(`[close] Connection closed cleanly, code=${event.code} reason=${event.reason}`);
            } else {
                // e.g. server process killed or network down
                // event.code is usually 1006 in this case
                console.log('[close] Connection died');
            }
        };

        server_socket.onerror = function (error) {
            console.log(`[error] ${error.message}`);
        };
    },
    broadcast(data) {
        for (const peer of Object.values(peer_connections)) {
            peer.data_channel.send(data);
        }
    },
    message_specific_peer(peer_id, data) {
        let peer = peer_connections[peer_id];

        peer.data_channel.send(data);
    }
};
export default room;