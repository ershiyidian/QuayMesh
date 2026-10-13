using QuayMesh.Shared;

namespace QuayMesh.Host;

public sealed class RollingLog : IDisposable
{
    private readonly string _path;
    private readonly long _limit;
    private readonly object _gate = new();
    private StreamWriter? _writer;

    public RollingLog(string path, long limitBytes = 5 * 1024 * 1024)
    {
        _path = path;
        _limit = limitBytes;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    }

    public void Write(string line)
    {
        var text = SecretRedactor.Redact(line);
        lock (_gate)
        {
            Rotate();
            _writer ??= new StreamWriter(new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read)) { AutoFlush = true };
            _writer.WriteLine($"{DateTimeOffset.Now:O} {text}");
        }
    }

    private void Rotate()
    {
        if (!File.Exists(_path) || new FileInfo(_path).Length < _limit) return;
        _writer?.Dispose();
        _writer = null;
        for (var index = 3; index >= 1; index--)
        {
            var source = index == 1 ? _path : _path + "." + (index - 1);
            var destination = _path + "." + index;
            if (!File.Exists(source)) continue;
            if (File.Exists(destination)) File.Delete(destination);
            File.Move(source, destination);
        }
    }

    public void Dispose()
    {
        lock (_gate) _writer?.Dispose();
    }
}
