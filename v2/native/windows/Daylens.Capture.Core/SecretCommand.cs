namespace Daylens.Capture.Core;

/// `--secret get|set|delete <name>`: the capture service keeps browser pairing keys in secure storage through this.
/// The secret itself only ever crosses stdin and stdout.
public sealed record SecretCommand(string Op, string Name)
{
    /// Exit status when the item does not exist.
    public const int NotFound = 2;

    public static string Target(string name) => $"Daylens/browser-pairing/{name}";

    public static SecretCommand? Parse(string[] args)
    {
        var i = Array.IndexOf(args, "--secret");
        if (i < 0 || i + 2 >= args.Length) return null;
        var op = args[i + 1];
        var name = args[i + 2];
        if (op is not ("get" or "set" or "delete")) return null;
        if (name.Length != 22 || !name.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) return null;
        return new SecretCommand(op, name);
    }
}
