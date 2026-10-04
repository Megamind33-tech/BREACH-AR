using System.Text.Json;

namespace Viro.Agent.Care.Move;

/// <summary>Viro Move over the signed-in Viro account.</summary>
public sealed class AccountMoveApi(AccountService account) : IMoveApi
{
    public Task<(int Status, JsonElement Body)> JsonAsync(HttpMethod method, string path, object? body, CancellationToken ct) => account.SendAsync(method, path, body, ct);
    public async Task<int> PutChunkAsync(string path, byte[] data, string sha256, CancellationToken ct) => (await account.SendBytesAsync(HttpMethod.Put, path, data, sha256, ct)).Status;
    public Task<(int Status, byte[] Data, string? Sha256)> GetChunkAsync(string path, CancellationToken ct) => account.SendBytesAsync(HttpMethod.Get, path, null, null, ct);
}
