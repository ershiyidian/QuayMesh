using Windows.Security.Credentials;

namespace QuayMesh.Tests;

[TestClass]
public sealed class SessionTests
{
    private const string TestResource = "QuayMesh.TestResource";

    [TestMethod]
    public void PasswordVault_CanStoreRetrieveAndRemoveCredentials()
    {
        var vault = new PasswordVault();
        var testUser = "test-user-" + Guid.NewGuid().ToString("N");
        var testPassword = "test-secret-token";

        try
        {
            var credential = new PasswordCredential(TestResource, testUser, testPassword);
            vault.Add(credential);

            var retrieved = vault.Retrieve(TestResource, testUser);
            retrieved.RetrievePassword();

            Assert.AreEqual(testPassword, retrieved.Password, "凭据存储后读取的密码必须一致。");
        }
        finally
        {
            try
            {
                var existing = vault.Retrieve(TestResource, testUser);
                vault.Remove(existing);
            }
            catch
            {
            }
        }
    }
}
