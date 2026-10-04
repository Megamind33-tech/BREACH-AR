using System.Security.Cryptography;
using System.Text;

namespace WorkCare.QuickCheck;

/// <summary>
/// WCP1 (computer side, plus the phone side for tests). Same primitives and byte layouts as packages/pairing-protocol: ECDH P-256, HMAC-SHA256, HKDF-SHA256, AES-256-GCM.
/// Checked against the shared fixed vectors (Wcp1ConformanceTests). A session grants inspection only; it expires, is single use, locks after repeated failures, and can be revoked.
/// </summary>
public static class Wcp1
{
    public const int MaxFailedAttempts = 5;
    public const int CodeTtlSeconds = 300;
    public static string B64u(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static byte[] UnB64u(string s) { var t = s.Replace('-', '+').Replace('_', '/'); t = t.PadRight(t.Length + (4 - t.Length % 4) % 4, '='); return Convert.FromBase64String(t); }
    public static string Hex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();
    public static byte[] FromHex(string s) => Convert.FromHexString(s);

    public sealed record Offer(byte[] SessionId, byte[] PcPub, long ExpiresAt, byte[] Secret);
    public sealed record Hello(byte[] PhonePub, byte[] NonceP, byte[] Proof);
    public sealed record Accept(byte[] NonceC, byte[] Proof);
    public sealed record Keys(byte[] ClientKey, byte[] ServerKey, string Sas);

    static byte[] Hmac(byte[] key, params byte[][] parts) { using var h = new HMACSHA256(key); h.Initialize(); foreach (var p in parts) h.TransformBlock(p, 0, p.Length, null, 0); h.TransformFinalBlock([], 0, 0); return h.Hash!; }
    static byte[] S(string s) => Encoding.UTF8.GetBytes(s);
    static byte[] Sha256(params byte[][] parts) { using var h = SHA256.Create(); return h.ComputeHash(parts.SelectMany(p => p).ToArray()); }

    public static byte[] SecretFromCode(string code) => Hmac(S("WCP1 code"), S(new string(code.Where(char.IsDigit).ToArray())))[..16];
    public static string NewCode() { var n = BitConverter.ToUInt32(RandomNumberGenerator.GetBytes(4).Reverse().ToArray(), 0) % 1_000_000_000UL; var s = n.ToString().PadLeft(9, '0'); return $"{s[..3]}-{s.Substring(3, 3)}-{s[6..]}"; }

    public static ECDiffieHellman NewKey() => ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
    public static byte[] PublicBytes(ECDiffieHellman k) { var p = k.ExportParameters(false); return [4, .. Pad32(p.Q.X!), .. Pad32(p.Q.Y!)]; }
    static byte[] Pad32(byte[] b) => b.Length == 32 ? b : [.. new byte[32 - b.Length], .. b];
    public static ECDiffieHellman KeyFrom(byte[] scalar, byte[] publicBytes) => ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, D = scalar, Q = new ECPoint { X = publicBytes[1..33], Y = publicBytes[33..65] } });
    static ECDiffieHellmanPublicKey PublicFrom(byte[] raw)
    {
        if (raw.Length != 65 || raw[0] != 4) throw new CryptographicException("invalid public key");
        using var e = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = raw[1..33], Y = raw[33..65] } });
        return e.PublicKey;
    }
    static byte[] Shared(ECDiffieHellman priv, byte[] otherPub) => priv.DeriveRawSecretAgreement(PublicFrom(otherPub));

    static byte[] HelloProof(byte[] q, byte[] sid, byte[] pcPub, byte[] phonePub, byte[] nonceP) => Hmac(q, S("hello"), sid, pcPub, phonePub, nonceP);
    static byte[] AcceptProof(byte[] q, byte[] sid, byte[] pcPub, byte[] phonePub, byte[] nonceP, byte[] nonceC) => Hmac(q, S("accept"), sid, pcPub, phonePub, nonceP, nonceC);
    public static Keys DeriveKeys(byte[] shared, byte[] q, byte[] sid, byte[] nonceP, byte[] nonceC)
    {
        var salt = Sha256(sid, nonceP, nonceC); var ikm = shared.Concat(q).ToArray();
        var okm = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 64, salt, S("WCP1 keys")); var sas = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 4, salt, S("WCP1 sas"));
        var n = ((uint)sas[0] << 24 | (uint)sas[1] << 16 | (uint)sas[2] << 8 | sas[3]) % 1_000_000;
        return new(okm[..32], okm[32..], n.ToString().PadLeft(6, '0'));
    }

    // ------------------------------------------------------------------------------------------ the computer side
    public enum Refusal { Expired, BadProof, Locked, Used, Malformed }
    public sealed class PcSession(Offer offer, ECDiffieHellman key)
    {
        public Offer Offer { get; } = offer; readonly ECDiffieHellman _key = key;
        public int Failed { get; private set; }
        public bool Used { get; private set; }
        public bool Revoked { get; private set; }
        public void Revoke() => Revoked = true;
        public static PcSession Create(long nowSeconds, byte[] secret, int ttl = CodeTtlSeconds, ECDiffieHellman? key = null, byte[]? sessionId = null)
        { key ??= NewKey(); return new(new Offer(sessionId ?? RandomNumberGenerator.GetBytes(16), PublicBytes(key), nowSeconds + ttl, secret), key); }

        public (Accept? accept, Keys? keys, Refusal? refusal) HandleHello(Hello h, long nowSeconds, byte[]? nonceC = null)
        {
            if (Revoked || nowSeconds >= Offer.ExpiresAt) return (null, null, Refusal.Expired);
            if (Failed >= MaxFailedAttempts) return (null, null, Refusal.Locked);
            if (Used) return (null, null, Refusal.Used);
            if (h.PhonePub.Length != 65 || h.NonceP.Length != 16) return (null, null, Refusal.Malformed);
            if (!CryptographicOperations.FixedTimeEquals(h.Proof, HelloProof(Offer.Secret, Offer.SessionId, Offer.PcPub, h.PhonePub, h.NonceP))) { Failed++; return (null, null, Refusal.BadProof); }
            byte[] shared; try { shared = Shared(_key, h.PhonePub); } catch (CryptographicException) { Failed++; return (null, null, Refusal.Malformed); }
            Used = true; nonceC ??= RandomNumberGenerator.GetBytes(16);
            return (new Accept(nonceC, AcceptProof(Offer.Secret, Offer.SessionId, Offer.PcPub, h.PhonePub, h.NonceP, nonceC)), DeriveKeys(shared, Offer.Secret, Offer.SessionId, h.NonceP, nonceC), null);
        }
    }

    // ------------------------------------------------------------------------------------------ the phone side (used by tests and any future desktop-to-desktop use)
    public sealed class PhoneHandshake
    {
        readonly Offer _offer; readonly ECDiffieHellman _key; public Hello Hello { get; }
        public PhoneHandshake(Offer offer, ECDiffieHellman? key = null, byte[]? nonce = null)
        { _offer = offer; _key = key ?? NewKey(); var pub = PublicBytes(_key); var n = nonce ?? RandomNumberGenerator.GetBytes(16); Hello = new Hello(pub, n, HelloProof(offer.Secret, offer.SessionId, offer.PcPub, pub, n)); }
        public Keys Finish(Accept a)
        {
            if (!CryptographicOperations.FixedTimeEquals(a.Proof, AcceptProof(_offer.Secret, _offer.SessionId, _offer.PcPub, Hello.PhonePub, Hello.NonceP, a.NonceC))) throw new CryptographicException("the computer did not prove it holds this pairing code");
            return DeriveKeys(Shared(_key, _offer.PcPub), _offer.Secret, _offer.SessionId, Hello.NonceP, a.NonceC);
        }
    }

    // ------------------------------------------------------------------------------------------ frames
    public const int C2S = 1, S2C = 2;
    static byte[] NonceOf(int dir, ulong counter) { var n = new byte[12]; n[0] = (byte)(dir >> 24); n[1] = (byte)(dir >> 16); n[2] = (byte)(dir >> 8); n[3] = (byte)dir; for (var i = 0; i < 8; i++) n[4 + i] = (byte)(counter >> (56 - 8 * i)); return n; }
    static byte[] AadOf(byte[] sid, int dir, ulong counter) { var a = new byte[25]; sid.CopyTo(a, 0); a[16] = (byte)dir; for (var i = 0; i < 8; i++) a[17 + i] = (byte)(counter >> (56 - 8 * i)); return a; }
    static byte[] CounterBytes(ulong c) { var b = new byte[8]; for (var i = 0; i < 8; i++) b[i] = (byte)(c >> (56 - 8 * i)); return b; }
    public static byte[] Seal(byte[] key, byte[] sid, int dir, ulong counter, byte[] plaintext)
    {
        var ct = new byte[plaintext.Length]; var tag = new byte[16]; using var g = new AesGcm(key, 16); g.Encrypt(NonceOf(dir, counter), plaintext, ct, tag, AadOf(sid, dir, counter));
        return [.. CounterBytes(counter), .. ct, .. tag];
    }
    public static (ulong counter, byte[] plaintext) Open(byte[] key, byte[] sid, int dir, byte[] frame)
    {
        if (frame.Length < 24) throw new CryptographicException("frame too short");
        ulong counter = 0; for (var i = 0; i < 8; i++) counter = counter << 8 | frame[i];
        var ct = frame[8..^16]; var tag = frame[^16..]; var pt = new byte[ct.Length];
        using var g = new AesGcm(key, 16); g.Decrypt(NonceOf(dir, counter), ct, tag, pt, AadOf(sid, dir, counter));
        return (counter, pt);
    }

    /// <summary>One side of an established session. Counters must strictly increase in each direction, so a replayed or reordered frame is refused.</summary>
    public sealed class Channel(Keys keys, byte[] sid, bool server)
    {
        ulong _send; long _last = -1;
        public byte[] Send(byte[] plain) => Seal(server ? keys.ServerKey : keys.ClientKey, sid, server ? S2C : C2S, _send++, plain);
        public byte[] Receive(byte[] frame)
        {
            var (c, p) = Open(server ? keys.ClientKey : keys.ServerKey, sid, server ? C2S : S2C, frame);
            if ((long)c <= _last) throw new CryptographicException("replayed or out-of-order frame");
            _last = (long)c; return p;
        }
    }
}
