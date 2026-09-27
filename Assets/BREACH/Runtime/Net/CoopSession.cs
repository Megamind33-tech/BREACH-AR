using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using Breach.Core.Net;
using Unity.Collections;
using Unity.Netcode;
using Unity.Netcode.Transports.UTP;
using UnityEngine;

namespace Breach.Net
{
    public enum NetRole
    {
        Offline,
        Host,
        Client,
    }

    /// <summary>
    /// Co-op session over the local Wi-Fi. Netcode for GameObjects is used as
    /// a connection + message pipe only (named messages); no NetworkObjects or
    /// prefabs, because BREACH builds its whole world in code. The host is
    /// authoritative for the Hunter, damage and score.
    /// </summary>
    public sealed class CoopSession : MonoBehaviour
    {
        public const ushort Port = 7788;
        static readonly string[] Callsigns = { "ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT" };

        NetworkManager _nm;
        UnityTransport _transport;
        float _joinDeadline;

        public NetRole Role { get; private set; } = NetRole.Offline;
        public string Status { get; private set; } = "offline";
        public string RoomCodeText { get; private set; } = "";
        public IPAddress LocalAddress { get; private set; }
        public bool Connected => _nm != null && _nm.IsListening && (_nm.IsServer || _nm.IsConnectedClient);
        public ulong LocalId => _nm != null && _nm.IsListening ? _nm.LocalClientId : 0;
        public bool IsNetworked => Role != NetRole.Offline;

        public sealed class Peer
        {
            public ulong Id;
            public string Callsign;
            public PlayerPose Pose;
            public double LastPoseTime = -1;
            public readonly SnapshotBuffer Buffer = new SnapshotBuffer { InterpolationDelay = 0.1f, TeleportDistance = 3f };
        }

        /// <summary>Remote players (never contains the local player).</summary>
        public readonly Dictionary<ulong, Peer> Peers = new Dictionary<ulong, Peer>();
        public RosterEntry[] Roster { get; private set; } = new RosterEntry[0];

        public event Action<ulong, PlayerPose> PoseReceived;
        public event Action<HunterSnapshot> HunterReceived;
        public event Action<MatchSnapshot> MatchReceived;
        public event Action<ulong, GameEvent> EventReceived;
        public event Action<RosterEntry[]> RosterReceived;
        public event Action<ulong> PeerJoined;
        public event Action<ulong> PeerLeft;
        public event Action JoinedHost;
        public event Action<string> Ended;

        public static string CallsignFor(ulong id) => Callsigns[(int)(id % (ulong)Callsigns.Length)];

        public static CoopSession Create(Transform parent)
        {
            var go = new GameObject("Co-op Session");
            go.transform.SetParent(parent, false);
            return go.AddComponent<CoopSession>();
        }

        void EnsureManager()
        {
            if (_nm != null) return;
            var go = new GameObject("BREACH Netcode");
            go.SetActive(false);
            go.transform.SetParent(transform, false);
            _transport = go.AddComponent<UnityTransport>();
            _nm = go.AddComponent<NetworkManager>();
            _nm.NetworkConfig = new NetworkConfig
            {
                NetworkTransport = _transport,
                EnableSceneManagement = false,
                ConnectionApproval = false,
                ForceSamePrefabs = false,
                TickRate = 30,
            };
            go.SetActive(true);
            _nm.OnClientConnectedCallback += OnClientConnected;
            _nm.OnClientDisconnectCallback += OnClientDisconnected;
            _nm.OnTransportFailure += () => Fail("network transport failure");
        }

        public bool Host()
        {
            if (Busy) { Status = "network still shutting down — try again"; return false; }
            Leave();
            EnsureManager();
            LocalAddress = LocalNetwork.GetLocalIPv4();
            _transport.SetConnectionData("0.0.0.0", Port, "0.0.0.0");
            if (!_nm.StartHost())
            {
                Fail("could not start host (is Wi-Fi on?)");
                return false;
            }
            Role = NetRole.Host;
            RegisterHandlers();
            RoomCodeText = LocalAddress != null ? RoomCode.FromAddress(LocalAddress) : "NO WI-FI";
            Status = LocalAddress != null ? "hosting" : "hosting — no Wi-Fi address found";
            return true;
        }

        public bool Join(string code)
        {
            if (Busy) { Status = "network still shutting down — try again"; return false; }
            Leave();
            LocalAddress = LocalNetwork.GetLocalIPv4();
            if (!RoomCode.TryResolve(code, LocalAddress ?? IPAddress.Loopback, out var host))
            {
                Fail("invalid room code");
                return false;
            }
            EnsureManager();
            _transport.SetConnectionData(host.ToString(), Port);
            if (!_nm.StartClient())
            {
                Fail("could not start client");
                return false;
            }
            Role = NetRole.Client;
            RegisterHandlers();
            Status = $"connecting to {host}";
            _joinDeadline = Time.unscaledTime + 8f;
            return true;
        }

        public void Leave()
        {
            if (_nm != null && _nm.IsListening)
            {
                var cmm = _nm.CustomMessagingManager;
                if (cmm != null)
                    foreach (var ch in new[] { NetProtocol.PoseChannel, NetProtocol.HunterChannel, NetProtocol.MatchChannel, NetProtocol.EventChannel, NetProtocol.RosterChannel })
                        cmm.UnregisterNamedMessageHandler(ch);
                _nm.Shutdown();
            }
            Peers.Clear();
            Roster = new RosterEntry[0];
            Role = NetRole.Offline;
            RoomCodeText = "";
            Status = "offline";
            _joinDeadline = 0;
        }

        /// <summary>NGO needs a frame to finish a shutdown before it can start again.</summary>
        public bool Busy => _nm != null && _nm.ShutdownInProgress;

        void OnDestroy()
        {
            if (_nm != null && _nm.IsListening) _nm.Shutdown();
        }

        string _pendingFailure;

        /// <summary>Failures can be reported from inside NGO callbacks; tear down on the next Update instead.</summary>
        void Fail(string why)
        {
            Debug.LogWarning("[BREACH][NET] " + why);
            Status = why;
            _pendingFailure = why;
        }

        void Update()
        {
            if (_pendingFailure != null)
            {
                var why = _pendingFailure;
                _pendingFailure = null;
                Leave();
                Status = why;
                Ended?.Invoke(why);
                return;
            }
            if (Role == NetRole.Client && !Connected && _joinDeadline > 0 && Time.unscaledTime > _joinDeadline)
            {
                _joinDeadline = 0;
                Fail("no host answered — check the room code and that both phones share the Wi-Fi");
            }
        }

        void OnClientConnected(ulong id)
        {
            if (Role == NetRole.Host)
            {
                if (id == _nm.LocalClientId) return;
                Peers[id] = new Peer { Id = id, Callsign = CallsignFor(id) };
                Status = $"hosting — {Peers.Count} teammate(s)";
                PeerJoined?.Invoke(id);
            }
            else if (id == _nm.LocalClientId)
            {
                _joinDeadline = 0;
                Status = "connected as " + CallsignFor(id);
                Peers[NetworkManager.ServerClientId] = new Peer { Id = NetworkManager.ServerClientId, Callsign = CallsignFor(NetworkManager.ServerClientId) };
                JoinedHost?.Invoke();
            }
        }

        void OnClientDisconnected(ulong id)
        {
            if (Role == NetRole.Host)
            {
                if (Peers.Remove(id)) PeerLeft?.Invoke(id);
                Status = $"hosting — {Peers.Count} teammate(s)";
            }
            else if (Role == NetRole.Client && (id == _nm.LocalClientId || id == NetworkManager.ServerClientId))
            {
                Fail("disconnected from host");
            }
        }

        // ------------------------------------------------------------------ messaging

        void RegisterHandlers()
        {
            var cmm = _nm.CustomMessagingManager;
            cmm.RegisterNamedMessageHandler(NetProtocol.PoseChannel, (sender, reader) =>
            {
                var p = NetProtocol.DecodePose(ReadPayload(reader));
                // Host trusts the transport's sender id over the payload; clients trust the host's relay.
                ulong subject = Role == NetRole.Host ? sender : p.Subject;
                if (subject == LocalId) return;
                p.Subject = subject;
                if (!Peers.TryGetValue(subject, out var peer))
                {
                    if (Role == NetRole.Host) return; // unknown sender
                    peer = new Peer { Id = subject, Callsign = CallsignFor(subject) };
                    Peers[subject] = peer;
                }
                peer.Pose = p;
                peer.LastPoseTime = Time.timeAsDouble;
                PoseReceived?.Invoke(subject, p);
                if (Role == NetRole.Host)
                {
                    var relay = NetProtocol.Encode(p);
                    foreach (var id in _nm.ConnectedClientsIds)
                        if (id != _nm.LocalClientId && id != subject) Send(NetProtocol.PoseChannel, relay, id, NetworkDelivery.UnreliableSequenced);
                }
            });
            cmm.RegisterNamedMessageHandler(NetProtocol.HunterChannel, (sender, reader) =>
                HunterReceived?.Invoke(NetProtocol.DecodeHunter(ReadPayload(reader))));
            cmm.RegisterNamedMessageHandler(NetProtocol.MatchChannel, (sender, reader) =>
                MatchReceived?.Invoke(NetProtocol.DecodeMatch(ReadPayload(reader))));
            cmm.RegisterNamedMessageHandler(NetProtocol.EventChannel, (sender, reader) =>
                EventReceived?.Invoke(sender, NetProtocol.DecodeEvent(ReadPayload(reader))));
            cmm.RegisterNamedMessageHandler(NetProtocol.RosterChannel, (sender, reader) =>
            {
                Roster = NetProtocol.DecodeRoster(ReadPayload(reader));
                RosterReceived?.Invoke(Roster);
            });
        }

        static byte[] ReadPayload(FastBufferReader reader)
        {
            reader.ReadValueSafe(out int length);
            var bytes = new byte[Mathf.Max(0, length)];
            if (length > 0) reader.ReadBytesSafe(ref bytes, length);
            return bytes;
        }

        void Send(string channel, byte[] data, ulong target, NetworkDelivery delivery)
        {
            if (!Connected) return;
            using (var w = new FastBufferWriter(data.Length + 8, Allocator.Temp))
            {
                w.WriteValueSafe(data.Length);
                w.WriteBytesSafe(data);
                _nm.CustomMessagingManager.SendNamedMessage(channel, target, w, delivery);
            }
        }

        void SendToOthers(string channel, byte[] data, NetworkDelivery delivery)
        {
            if (!Connected || Role != NetRole.Host) return;
            foreach (var id in _nm.ConnectedClientsIds)
                if (id != _nm.LocalClientId) Send(channel, data, id, delivery);
        }

        /// <summary>Client → host; host → every client (so clients can see the host's position too).</summary>
        public void SendPose(PlayerPose pose)
        {
            pose.Subject = LocalId;
            var data = NetProtocol.Encode(pose);
            if (Role == NetRole.Client) Send(NetProtocol.PoseChannel, data, NetworkManager.ServerClientId, NetworkDelivery.UnreliableSequenced);
            else SendToOthers(NetProtocol.PoseChannel, data, NetworkDelivery.UnreliableSequenced);
        }

        public void BroadcastHunter(in HunterSnapshot s) =>
            SendToOthers(NetProtocol.HunterChannel, NetProtocol.Encode(s), NetworkDelivery.UnreliableSequenced);

        public void BroadcastMatch(in MatchSnapshot m) =>
            SendToOthers(NetProtocol.MatchChannel, NetProtocol.Encode(m), NetworkDelivery.ReliableSequenced);

        public void BroadcastRoster(RosterEntry[] roster)
        {
            Roster = roster;
            SendToOthers(NetProtocol.RosterChannel, NetProtocol.Encode(roster), NetworkDelivery.ReliableSequenced);
        }

        public void BroadcastEvent(in GameEvent e) =>
            SendToOthers(NetProtocol.EventChannel, NetProtocol.Encode(e), NetworkDelivery.ReliableSequenced);

        public void SendEventTo(ulong client, in GameEvent e) =>
            Send(NetProtocol.EventChannel, NetProtocol.Encode(e), client, NetworkDelivery.ReliableSequenced);

        public void SendEventToHost(in GameEvent e) =>
            Send(NetProtocol.EventChannel, NetProtocol.Encode(e), NetworkManager.ServerClientId, NetworkDelivery.ReliableSequenced);

        /// <summary>Round-trip time in ms to the host (client) or a given client (host).</summary>
        public float RttMs(ulong client)
        {
            if (!Connected || _transport == null) return -1;
            try { return _transport.GetCurrentRtt(Role == NetRole.Client ? NetworkManager.ServerClientId : client); }
            catch { return -1; }
        }
    }

    public static class LocalNetwork
    {
        /// <summary>This device's LAN IPv4 (the address the Wi-Fi uses), or null.</summary>
        public static IPAddress GetLocalIPv4()
        {
            // Connecting a UDP socket sends nothing; it just makes the OS pick the outbound interface.
            try
            {
                using (var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp))
                {
                    s.Connect("10.255.255.255", 1);
                    if (s.LocalEndPoint is IPEndPoint ep && !IPAddress.IsLoopback(ep.Address) && !ep.Address.Equals(IPAddress.Any))
                        return ep.Address;
                }
            }
            catch (Exception) { }
            try
            {
                foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                    foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                        if (ua.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ua.Address))
                            return ua.Address;
                }
            }
            catch (Exception) { }
            return null;
        }
    }
}
