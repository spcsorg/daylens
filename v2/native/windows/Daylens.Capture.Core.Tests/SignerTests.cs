using Daylens.Capture.Core;
using Xunit;

public class SignerTests
{
    [Theory]
    [InlineData("CN=\"Slack Technologies, LLC\", O=\"Slack Technologies, LLC\", L=San Francisco, S=California, C=US", "Slack Technologies, LLC")]
    [InlineData("CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US", "Microsoft Corporation")]
    [InlineData("CN=Some Developer", "Some Developer")]
    [InlineData("C=US, CN=Only CN", "Only CN")]
    public void PublisherPrefersTheOrganization(string subject, string expected) =>
        Assert.Equal(expected, Signers.PublisherFromSubject(subject));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("C=US, L=Nowhere")]
    public void NoPublisherWithoutANameOrOrganization(string? subject) => Assert.Null(Signers.PublisherFromSubject(subject));
}
