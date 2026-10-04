using System.Security.Cryptography;
using System.Text;

namespace Viro.Agent.Care.Move;

/// <summary>
/// Everything in a Viro Move snapshot is encrypted here, on the person's PC, with AES-256-GCM. The key is made from a passphrase only the person knows (PBKDF2-SHA256);
/// Viro never receives the passphrase or the key, so Viro cannot read a snapshot and cannot recover one if the passphrase is lost. Each piece is bound to its place
/// (snapshot id and position), so a chunk cannot be swapped, reordered or replayed without detection.
/// </summary>
public static class MoveCrypto
{
    public const int Iterations = 600_000;
    const int NonceSize = 12, TagSize = 16;

    public static byte[] DeriveKey(string passphrase, byte[] salt, int iterations = Iterations) =>
        Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(passphrase.Normalize(NormalizationForm.FormKC)), salt, iterations, HashAlgorithmName.SHA256, 32);

    public static byte[] NewSalt() => RandomNumberGenerator.GetBytes(16);

    /// <summary>nonce | ciphertext | tag. The associated data is authenticated but not stored: the reader must supply the same.</summary>
    public static byte[] Seal(byte[] key, ReadOnlySpan<byte> plain, string aad)
    {
        var nonce = RandomNumberGenerator.GetBytes(NonceSize); var cipher = new byte[plain.Length]; var tag = new byte[TagSize];
        using var gcm = new AesGcm(key, TagSize); gcm.Encrypt(nonce, plain, cipher, tag, Encoding.UTF8.GetBytes(aad));
        var o = new byte[NonceSize + cipher.Length + TagSize]; nonce.CopyTo(o, 0); cipher.CopyTo(o, NonceSize); tag.CopyTo(o, NonceSize + cipher.Length); return o;
    }

    /// <summary>Throws <see cref="CryptographicException"/> when the data was changed, belongs to another place, or the key is wrong.</summary>
    public static byte[] Open(byte[] key, ReadOnlySpan<byte> sealedData, string aad)
    {
        if (sealedData.Length < NonceSize + TagSize) throw new CryptographicException("too short");
        var nonce = sealedData[..NonceSize]; var tag = sealedData[^TagSize..]; var cipher = sealedData[NonceSize..^TagSize]; var plain = new byte[cipher.Length];
        using var gcm = new AesGcm(key, TagSize); gcm.Decrypt(nonce, cipher, tag, plain, Encoding.UTF8.GetBytes(aad)); return plain;
    }

    const string CheckText = "viro-move-key-check-v1";
    public static string MakeKeyCheck(byte[] key) => Convert.ToBase64String(Seal(key, Encoding.UTF8.GetBytes(CheckText), "key-check"));
    public static bool KeyMatches(byte[] key, string keyCheckBase64) { try { return Encoding.UTF8.GetString(Open(key, Convert.FromBase64String(keyCheckBase64), "key-check")) == CheckText; } catch (Exception e) when (e is CryptographicException or FormatException) { return false; } }

    public static string ChunkAad(string snapshotId, int index) => $"{snapshotId}|chunk|{index}";
    public static string ManifestAad(string snapshotId) => $"{snapshotId}|manifest";
}
