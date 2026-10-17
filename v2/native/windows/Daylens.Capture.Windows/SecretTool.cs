// --secret get|set|delete <name>: a generic credential in this user's Windows Credential Manager. Captures nothing.

using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Daylens.Capture.Core;

namespace Daylens.Capture.Windows;

[SupportedOSPlatform("windows")]
internal static unsafe partial class SecretTool
{
    const uint CRED_TYPE_GENERIC = 1, CRED_PERSIST_LOCAL_MACHINE = 2;
    const int ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential)]
    struct CREDENTIALW
    {
        public uint Flags; public uint Type; public char* TargetName; public char* Comment; public long LastWritten;
        public uint CredentialBlobSize; public byte* CredentialBlob; public uint Persist; public uint AttributeCount;
        public nint Attributes; public char* TargetAlias; public char* UserName;
    }

    [LibraryImport("advapi32.dll", EntryPoint = "CredWriteW", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CredWrite(CREDENTIALW* credential, uint flags);
    [LibraryImport("advapi32.dll", EntryPoint = "CredReadW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CredRead(string target, uint type, uint flags, out CREDENTIALW* credential);
    [LibraryImport("advapi32.dll", EntryPoint = "CredDeleteW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CredDelete(string target, uint type, uint flags);
    [LibraryImport("advapi32.dll")]
    private static partial void CredFree(void* buffer);

    public static int? TryRun(string[] args)
    {
        if (!args.Contains("--secret")) return null;
        if (SecretCommand.Parse(args) is not { } cmd) return 64;
        var target = SecretCommand.Target(cmd.Name);
        switch (cmd.Op)
        {
            case "set":
                var line = Console.In.ReadLine();
                if (string.IsNullOrEmpty(line)) return 65;
                var blob = Encoding.UTF8.GetBytes(line);
                fixed (char* t = target)
                fixed (byte* b = blob)
                {
                    var c = new CREDENTIALW { Type = CRED_TYPE_GENERIC, TargetName = t, CredentialBlob = b, CredentialBlobSize = (uint)blob.Length, Persist = CRED_PERSIST_LOCAL_MACHINE };
                    return CredWrite(&c, 0) ? 0 : 1;
                }
            case "get":
                if (!CredRead(target, CRED_TYPE_GENERIC, 0, out var cred))
                    return Marshal.GetLastPInvokeError() == ERROR_NOT_FOUND ? SecretCommand.NotFound : 1;
                try
                {
                    var s = Encoding.UTF8.GetString(cred->CredentialBlob, (int)cred->CredentialBlobSize);
                    var o = Console.OpenStandardOutput();
                    o.Write(Encoding.UTF8.GetBytes(s + "\n"));
                    o.Flush();
                    return 0;
                }
                finally { CredFree(cred); }
            default:
                if (CredDelete(target, CRED_TYPE_GENERIC, 0)) return 0;
                return Marshal.GetLastPInvokeError() == ERROR_NOT_FOUND ? SecretCommand.NotFound : 1;
        }
    }
}
