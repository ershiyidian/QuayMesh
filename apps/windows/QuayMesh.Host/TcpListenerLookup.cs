using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;

namespace QuayMesh.Host;

public sealed record TcpListenerInfo(IPAddress Address, int Port, int Pid, bool IsLoopback);

public static class TcpListenerLookup
{
    public static IReadOnlyList<TcpListenerInfo> Listeners(int port)
    {
        var result = new List<TcpListenerInfo>();
        ReadV4(result, port);
        if (result.Count == 0)
        {
            ReadV6(result, port);
        }
        return result;
    }

    public static int? ListeningPid(int port) => Listeners(port).Select(item => (int?)item.Pid).FirstOrDefault();

    public static bool IsLoopbackListening(int port) => Listeners(port).Any(item => item.IsLoopback);

    public static IReadOnlyList<TcpListenerInfo> ActiveListeners(int port)
    {
        try
        {
            return IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()
                .Where(endpoint => endpoint.Port == port)
                .Select(endpoint => new TcpListenerInfo(endpoint.Address, endpoint.Port, 0, IPAddress.IsLoopback(endpoint.Address)))
                .ToArray();
        }
        catch { return Array.Empty<TcpListenerInfo>(); }
    }

    private static void ReadV4(List<TcpListenerInfo> result, int port)
    {
        var rows = ReadTable(2, 5, Marshal.SizeOf<OwnerRowV4>(), out var count);
        if (rows == nint.Zero) return;
        try
        {
            var row = rows + 4;
            for (var index = 0; index < count; index++)
            {
                var entry = Marshal.PtrToStructure<OwnerRowV4>(row + index * Marshal.SizeOf<OwnerRowV4>());
                var currentPort = NetworkPort(entry.LocalPort);
                if (entry.State != 2 || currentPort != port) continue;
                var address = new IPAddress(entry.LocalAddress);
                result.Add(new TcpListenerInfo(address, currentPort, entry.OwningPid, IPAddress.IsLoopback(address)));
            }
        }
        finally { Marshal.FreeHGlobal(rows); }
    }

    private static void ReadV6(List<TcpListenerInfo> result, int port)
    {
        var rows = ReadTable(23, 5, Marshal.SizeOf<OwnerRowV6>(), out var count);
        if (rows == nint.Zero) return;
        try
        {
            var row = rows + 4;
            for (var index = 0; index < count; index++)
            {
                var entry = Marshal.PtrToStructure<OwnerRowV6>(row + index * Marshal.SizeOf<OwnerRowV6>());
                var currentPort = NetworkPort(entry.LocalPort);
                if (entry.State != 2 || currentPort != port) continue;
                var address = new IPAddress(entry.LocalAddress ?? new byte[16]);
                result.Add(new TcpListenerInfo(address, currentPort, entry.OwningPid, IPAddress.IsLoopback(address)));
            }
        }
        finally { Marshal.FreeHGlobal(rows); }
    }

    private static nint ReadTable(uint family, int tableClass, int rowSize, out int count)
    {
        count = 0;
        var size = 0;
        var error = GetExtendedTcpTable(nint.Zero, ref size, true, family, tableClass, 0);
        if (error != 122 || size < 4) return nint.Zero;
        var buffer = Marshal.AllocHGlobal(size);
        if (GetExtendedTcpTable(buffer, ref size, true, family, tableClass, 0) != 0) { Marshal.FreeHGlobal(buffer); return nint.Zero; }
        count = Marshal.ReadInt32(buffer);
        if (count < 0 || count > (size - 4) / rowSize) { Marshal.FreeHGlobal(buffer); count = 0; return nint.Zero; }
        return buffer;
    }

    private static int NetworkPort(uint value) => (int)((value >> 8 & 0xFF) | (value & 0xFF) << 8);

    [StructLayout(LayoutKind.Sequential)] private struct OwnerRowV4
    {
        public uint State, LocalAddress, LocalPort, RemoteAddress, RemotePort;
        public int OwningPid;
    }

    [StructLayout(LayoutKind.Sequential)] private struct OwnerRowV6
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[]? LocalAddress;
        public uint LocalScopeId;
        public uint LocalPort;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[]? RemoteAddress;
        public uint RemoteScopeId;
        public uint RemotePort;
        public uint State;
        public int OwningPid;
    }

    [DllImport("iphlpapi.dll", SetLastError = true)] private static extern uint GetExtendedTcpTable(nint table, ref int size, bool order, uint ipVersion, int tableClass, uint reserved);
}
