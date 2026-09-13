$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$source = Join-Path $repo "output\engine-source"
$fixture = Join-Path $repo "output\engine-request.json"
$testFile = Join-Path $source "tests\Sherwood.Tests\ExternalKitInteropTests.cs"
$revision = "47695b9bbc86658b1c420810fcb304c5ea68fb79"

if (-not (Test-Path (Join-Path $source ".git"))) {
  throw "Pinned engine checkout is missing at $source. Create it from the pinned Sherwood revision before running this harness."
}
if ((git -C $source rev-parse HEAD).Trim() -ne $revision) {
  throw "Engine checkout must be pinned to $revision."
}

Push-Location $repo
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  npx tsx test/engine/capture-request.ts $fixture
  if ($LASTEXITCODE -ne 0) { throw "request capture failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$testSource = @'
using System.Net;
using System.Text.Json;
using Dapper;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Npgsql;
using Sherwood.Tests.Infrastructure;

namespace Sherwood.Tests;

[Collection(nameof(PostgreSqlCollection))]
public sealed class ExternalKitInteropTests(PostgreSqlFixture postgres) : IAsyncLifetime
{
    private string _connectionString = null!;
    private string _databaseName = null!;

    public async Task InitializeAsync() => (_connectionString, _databaseName) = await postgres.CreateDatabaseAsync();
    public async Task DisposeAsync() => await postgres.DropDatabaseAsync(_databaseName);

    [Fact]
    public async Task Javascript_agent_kit_request_authenticates_through_real_mcp_and_postgres()
    {
        var fixturePath = Environment.GetEnvironmentVariable("GOSSIP_ENGINE_REQUEST")
            ?? throw new InvalidOperationException("GOSSIP_ENGINE_REQUEST is required");
        var fixture = JsonDocument.Parse(await File.ReadAllTextAsync(fixturePath)).RootElement;
        fixture.GetProperty("endpoint").GetString().Should().StartWith("https://");
        fixture.GetProperty("path").GetString().Should().Be("/mcp");

        using var factory = new SherwoodWebApplicationFactory(_connectionString, config =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Sherwood:AgentAccess:Enabled"] = "true",
                ["Sherwood:AgentAccess:Audience"] = fixture.GetProperty("audience").GetString()
            }));
        using var client = factory.CreateClient();
        using var request = CreateRequest(fixture);

        using var response = await client.SendAsync(request);
        response.StatusCode.Should().NotBe(HttpStatusCode.Unauthorized, await response.Content.ReadAsStringAsync());
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync());

        await using var db = new NpgsqlConnection(_connectionString);
        (await db.ExecuteScalarAsync<int>("SELECT count(*)::int FROM subscriber_channels WHERE channel_type='wallet'")).Should().Be(1);

        using var tampered = await client.SendAsync(CreateRequest(fixture, "{}"));
        tampered.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        using var replay = await client.SendAsync(CreateRequest(fixture));
        replay.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        using var wrongAudienceFactory = new SherwoodWebApplicationFactory(_connectionString, config =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Sherwood:AgentAccess:Enabled"] = "true",
                ["Sherwood:AgentAccess:Audience"] = "https://wrong.example"
            }));
        using var wrongAudience = await wrongAudienceFactory.CreateClient().SendAsync(CreateRequest(fixture));
        wrongAudience.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    private static HttpRequestMessage CreateRequest(JsonElement fixture, string? body = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, fixture.GetProperty("path").GetString());
        request.Content = new StringContent(body ?? fixture.GetProperty("body").GetString()!, System.Text.Encoding.UTF8, "application/json");
        foreach (var header in fixture.GetProperty("headers").EnumerateObject())
            request.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
        return request;
    }
}
'@

Set-Content -LiteralPath $testFile -Value $testSource -Encoding utf8
try {
  $env:GOSSIP_ENGINE_REQUEST = $fixture
  dotnet test (Join-Path $source "tests\Sherwood.Tests\Sherwood.Tests.csproj") --filter FullyQualifiedName~ExternalKitInteropTests -v minimal
  if ($LASTEXITCODE -ne 0) { throw "dotnet test failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item Env:GOSSIP_ENGINE_REQUEST -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $fixture -Force -ErrorAction SilentlyContinue
}
