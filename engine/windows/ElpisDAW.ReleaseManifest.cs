using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace ElpisDAW.Windows
{
    internal sealed class ReleasePackage
    {
        private readonly string rootPath;

        internal ReleasePackage(string rootPath, string version)
        {
            this.rootPath = rootPath;
            Version = version;
        }

        internal string RootPath
        {
            get { return rootPath; }
        }

        internal string Version { get; private set; }

        internal string ResolveFile(string relativePath)
        {
            return Path.GetFullPath(
                Path.Combine(rootPath, relativePath.Replace('/', Path.DirectorySeparatorChar))
            );
        }
    }

    internal static class ReleaseManifestValidator
    {
        private const int ManifestVersion = 1;
        private const int MaximumFileCount = 20000;
        private const int MaximumManifestBytes = 8 * 1024 * 1024;
        private const string ManifestFileName = "release-manifest.json";
        private static readonly string[] RequiredFiles =
        {
            "ElpisDAW.exe",
            "app/engine/server.mjs",
            "app/ui/index.html",
            "licenses/ElpisDAW-LICENSE.txt",
            "licenses/THIRD_PARTY_NOTICES.md",
            "native/HumStudio.DirectoryPicker.exe",
            "runtime/LICENSE",
            "runtime/node.exe"
        };
        private static readonly string[] RootKeys =
        {
            "files",
            "manifestVersion",
            "platform",
            "product",
            "version"
        };
        private static readonly string[] FileKeys =
        {
            "path",
            "sha256",
            "sizeBytes"
        };

        internal static ReleasePackage Validate(string requestedRootPath)
        {
            string rootPath = ValidateRootPath(requestedRootPath);
            string manifestPath = Path.Combine(rootPath, ManifestFileName);
            byte[] manifestBytes;

            try
            {
                FileInfo manifestInfo = new FileInfo(manifestPath);

                if (!manifestInfo.Exists || IsReparsePoint(manifestInfo.Attributes))
                {
                    throw new InvalidDataException(
                        "Release package does not contain a regular release-manifest.json file."
                    );
                }

                if (manifestInfo.Length <= 0 || manifestInfo.Length > MaximumManifestBytes)
                {
                    throw new InvalidDataException(
                        "release-manifest.json has an invalid file size."
                    );
                }

                manifestBytes = File.ReadAllBytes(manifestPath);
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch
            {
                throw new InvalidDataException("release-manifest.json could not be read.");
            }

            string manifestText;

            try
            {
                UTF8Encoding strictUtf8 = new UTF8Encoding(false, true);
                manifestText = strictUtf8.GetString(manifestBytes);

                if (manifestText.Length > 0 && manifestText[0] == '\uFEFF')
                {
                    throw new InvalidDataException("release-manifest.json must use UTF-8 without BOM.");
                }
            }
            catch (DecoderFallbackException)
            {
                throw new InvalidDataException("release-manifest.json is not valid UTF-8.");
            }

            Dictionary<string, object> manifest = ParseManifest(manifestText);
            RequireExactKeys(manifest, RootKeys, "release-manifest.json");

            if (RequireInteger(manifest, "manifestVersion", "release-manifest.json") != ManifestVersion)
            {
                throw new InvalidDataException("release-manifest.json uses an unsupported version.");
            }

            if (RequireString(manifest, "product", "release-manifest.json") != "ElpisDAW")
            {
                throw new InvalidDataException("release-manifest.json has an invalid product.");
            }

            if (RequireString(manifest, "platform", "release-manifest.json") != "windows-x64")
            {
                throw new InvalidDataException("release-manifest.json has an invalid platform.");
            }

            string version = RequireString(manifest, "version", "release-manifest.json");
            ValidateVersion(version);
            object[] files = manifest["files"] as object[];

            if (files == null || files.Length == 0 || files.Length > MaximumFileCount)
            {
                throw new InvalidDataException("release-manifest.json has an invalid files array.");
            }

            Dictionary<string, ManifestFile> expectedFiles =
                new Dictionary<string, ManifestFile>(StringComparer.OrdinalIgnoreCase);

            for (int index = 0; index < files.Length; index += 1)
            {
                Dictionary<string, object> file = files[index] as Dictionary<string, object>;

                if (file == null)
                {
                    throw new InvalidDataException("release-manifest.json contains an invalid file row.");
                }

                RequireExactKeys(file, FileKeys, "release-manifest.json file row");
                string relativePath = RequireString(file, "path", "release-manifest.json file row");
                ValidateRelativePath(relativePath);

                if (String.Equals(relativePath, ManifestFileName, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException(
                        "release-manifest.json must not list itself as a package file."
                    );
                }

                long sizeBytes = RequireInteger(file, "sizeBytes", "release-manifest.json file row");

                if (sizeBytes < 0)
                {
                    throw new InvalidDataException(
                        "release-manifest.json contains a negative file size."
                    );
                }

                string sha256 = RequireString(file, "sha256", "release-manifest.json file row");

                if (!IsSha256(sha256))
                {
                    throw new InvalidDataException(
                        "release-manifest.json contains an invalid SHA-256 value."
                    );
                }

                if (expectedFiles.ContainsKey(relativePath))
                {
                    throw new InvalidDataException(
                        "release-manifest.json contains a duplicate file path: " + relativePath
                    );
                }

                expectedFiles.Add(
                    relativePath,
                    new ManifestFile(relativePath, sizeBytes, sha256.ToLowerInvariant())
                );
            }

            ValidateRequiredFiles(expectedFiles);
            Dictionary<string, string> actualFiles = EnumeratePackageFiles(rootPath);

            if (actualFiles.Count != expectedFiles.Count)
            {
                throw new InvalidDataException(
                    "Release package file set does not match release-manifest.json."
                );
            }

            foreach (KeyValuePair<string, string> actualFile in actualFiles)
            {
                ManifestFile expectedFile;

                if (!expectedFiles.TryGetValue(actualFile.Key, out expectedFile))
                {
                    throw new InvalidDataException(
                        "Release package contains an unlisted file: " + actualFile.Key
                    );
                }

                ValidateFile(actualFile.Value, expectedFile);
            }

            return new ReleasePackage(rootPath, version);
        }

        private static string ValidateRootPath(string requestedRootPath)
        {
            if (String.IsNullOrWhiteSpace(requestedRootPath) || !Path.IsPathRooted(requestedRootPath))
            {
                throw new InvalidDataException("Release package root must be an absolute path.");
            }

            string rootPath;

            try
            {
                rootPath = Path.GetFullPath(requestedRootPath);
                string volumeRoot = Path.GetPathRoot(rootPath);

                if (String.Equals(rootPath, volumeRoot, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException(
                        "Release package root must be an extracted application directory."
                    );
                }

                rootPath = rootPath.TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar
                );
            }
            catch
            {
                throw new InvalidDataException("Release package root path is invalid.");
            }

            if (!Directory.Exists(rootPath))
            {
                throw new InvalidDataException("Release package root is unavailable.");
            }

            return rootPath;
        }

        private static Dictionary<string, object> ParseManifest(string manifestText)
        {
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = MaximumManifestBytes;
                serializer.RecursionLimit = 64;
                Dictionary<string, object> manifest =
                    serializer.DeserializeObject(manifestText) as Dictionary<string, object>;

                if (manifest == null)
                {
                    throw new InvalidDataException("release-manifest.json must contain one object.");
                }

                return manifest;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch
            {
                throw new InvalidDataException("release-manifest.json is not valid JSON.");
            }
        }

        private static void RequireExactKeys(
            Dictionary<string, object> value,
            string[] expectedKeys,
            string label
        )
        {
            if (value.Count != expectedKeys.Length)
            {
                throw new InvalidDataException(label + " has an unexpected field set.");
            }

            for (int index = 0; index < expectedKeys.Length; index += 1)
            {
                if (!value.ContainsKey(expectedKeys[index]))
                {
                    throw new InvalidDataException(label + " is missing a required field.");
                }
            }
        }

        private static string RequireString(
            Dictionary<string, object> value,
            string key,
            string label
        )
        {
            string result = value[key] as string;

            if (String.IsNullOrWhiteSpace(result) || result != result.Trim())
            {
                throw new InvalidDataException(label + " contains an invalid " + key + ".");
            }

            return result;
        }

        private static long RequireInteger(
            Dictionary<string, object> value,
            string key,
            string label
        )
        {
            object raw = value[key];

            if (
                !(raw is Int32) &&
                !(raw is Int64) &&
                !(raw is Decimal) &&
                !(raw is Double)
            )
            {
                throw new InvalidDataException(label + " contains an invalid " + key + ".");
            }

            try
            {
                decimal decimalValue = Convert.ToDecimal(raw, CultureInfo.InvariantCulture);
                long integerValue = Convert.ToInt64(raw, CultureInfo.InvariantCulture);

                if (decimalValue != integerValue)
                {
                    throw new InvalidDataException(label + " contains a non-integer " + key + ".");
                }

                return integerValue;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch
            {
                throw new InvalidDataException(label + " contains an invalid " + key + ".");
            }
        }

        private static void ValidateVersion(string version)
        {
            if (version.Length > 64 || !IsAsciiLetterOrDigit(version[0]))
            {
                throw new InvalidDataException("release-manifest.json version is invalid.");
            }

            for (int index = 0; index < version.Length; index += 1)
            {
                char character = version[index];

                if (
                    !IsAsciiLetterOrDigit(character) &&
                    character != '.' &&
                    character != '+' &&
                    character != '-'
                )
                {
                    throw new InvalidDataException(
                        "release-manifest.json version contains an invalid character."
                    );
                }
            }
        }

        private static void ValidateRelativePath(string relativePath)
        {
            if (
                relativePath.IndexOf('\\') >= 0 ||
                relativePath.IndexOf(':') >= 0 ||
                relativePath.IndexOf('\0') >= 0 ||
                relativePath.StartsWith("/", StringComparison.Ordinal)
            )
            {
                throw new InvalidDataException(
                    "release-manifest.json contains an unsafe file path."
                );
            }

            string[] segments = relativePath.Split('/');

            for (int index = 0; index < segments.Length; index += 1)
            {
                string segment = segments[index];

                if (
                    String.IsNullOrWhiteSpace(segment) ||
                    segment != segment.Trim() ||
                    segment == "." ||
                    segment == ".." ||
                    segment.StartsWith(".", StringComparison.Ordinal) ||
                    segment.EndsWith(".", StringComparison.Ordinal) ||
                    segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
                )
                {
                    throw new InvalidDataException(
                        "release-manifest.json contains an unsafe file path."
                    );
                }
            }
        }

        private static bool IsAsciiLetterOrDigit(char character)
        {
            return
                (character >= '0' && character <= '9') ||
                (character >= 'A' && character <= 'Z') ||
                (character >= 'a' && character <= 'z');
        }

        private static bool IsSha256(string value)
        {
            if (value.Length != 64)
            {
                return false;
            }

            for (int index = 0; index < value.Length; index += 1)
            {
                char character = value[index];

                if (
                    !(character >= '0' && character <= '9') &&
                    !(character >= 'a' && character <= 'f') &&
                    !(character >= 'A' && character <= 'F')
                )
                {
                    return false;
                }
            }

            return true;
        }

        private static void ValidateRequiredFiles(
            Dictionary<string, ManifestFile> expectedFiles
        )
        {
            for (int index = 0; index < RequiredFiles.Length; index += 1)
            {
                if (!expectedFiles.ContainsKey(RequiredFiles[index]))
                {
                    throw new InvalidDataException(
                        "release-manifest.json is missing required file: " + RequiredFiles[index]
                    );
                }
            }

            bool hasRuntimeNotice = false;

            foreach (string relativePath in expectedFiles.Keys)
            {
                if (
                    relativePath.StartsWith(
                        "runtime/THIRD_PARTY_NOTICES/",
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                {
                    hasRuntimeNotice = true;
                    break;
                }
            }

            if (!hasRuntimeNotice)
            {
                throw new InvalidDataException(
                    "release-manifest.json must include a Node.js third-party notice file."
                );
            }
        }

        private static Dictionary<string, string> EnumeratePackageFiles(string rootPath)
        {
            Dictionary<string, string> files =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            EnumerateDirectory(rootPath, rootPath, files);
            return files;
        }

        private static void EnumerateDirectory(
            string rootPath,
            string directoryPath,
            Dictionary<string, string> files
        )
        {
            DirectoryInfo directory;

            try
            {
                directory = new DirectoryInfo(directoryPath);

                foreach (FileInfo file in directory.GetFiles())
                {
                    if (IsReparsePoint(file.Attributes))
                    {
                        throw new InvalidDataException(
                            "Release package contains a reparse-point file."
                        );
                    }

                    string relativePath = ToRelativePath(rootPath, file.FullName);

                    if (String.Equals(relativePath, ManifestFileName, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    if (files.ContainsKey(relativePath))
                    {
                        throw new InvalidDataException(
                            "Release package contains a duplicate file path."
                        );
                    }

                    files.Add(relativePath, file.FullName);
                }

                foreach (DirectoryInfo child in directory.GetDirectories())
                {
                    if (IsReparsePoint(child.Attributes))
                    {
                        throw new InvalidDataException(
                            "Release package contains a reparse-point directory."
                        );
                    }

                    EnumerateDirectory(rootPath, child.FullName, files);
                }
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch
            {
                throw new InvalidDataException("Release package file set could not be inspected.");
            }
        }

        private static string ToRelativePath(string rootPath, string fullPath)
        {
            string prefix = rootPath + Path.DirectorySeparatorChar;

            if (!fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("Release package file escaped the package root.");
            }

            return fullPath.Substring(prefix.Length).Replace(Path.DirectorySeparatorChar, '/');
        }

        private static void ValidateFile(string fullPath, ManifestFile expectedFile)
        {
            FileInfo fileInfo = new FileInfo(fullPath);

            if (!fileInfo.Exists || IsReparsePoint(fileInfo.Attributes))
            {
                throw new InvalidDataException(
                    "Release package contains an unavailable file: " + expectedFile.RelativePath
                );
            }

            if (fileInfo.Length != expectedFile.SizeBytes)
            {
                throw new InvalidDataException(
                    "Release package size mismatch: " + expectedFile.RelativePath
                );
            }

            string actualSha256;

            try
            {
                using (FileStream stream = new FileStream(
                    fullPath,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    1024 * 1024,
                    FileOptions.SequentialScan
                ))
                using (SHA256 hash = SHA256.Create())
                {
                    actualSha256 = ToHex(hash.ComputeHash(stream));
                }
            }
            catch
            {
                throw new InvalidDataException(
                    "Release package file could not be hashed: " + expectedFile.RelativePath
                );
            }

            if (!String.Equals(actualSha256, expectedFile.Sha256, StringComparison.Ordinal))
            {
                throw new InvalidDataException(
                    "Release package hash mismatch: " + expectedFile.RelativePath
                );
            }
        }

        private static string ToHex(byte[] bytes)
        {
            StringBuilder result = new StringBuilder(bytes.Length * 2);

            for (int index = 0; index < bytes.Length; index += 1)
            {
                result.Append(bytes[index].ToString("x2", CultureInfo.InvariantCulture));
            }

            return result.ToString();
        }

        private static bool IsReparsePoint(FileAttributes attributes)
        {
            return (attributes & FileAttributes.ReparsePoint) == FileAttributes.ReparsePoint;
        }

        private sealed class ManifestFile
        {
            internal ManifestFile(string relativePath, long sizeBytes, string sha256)
            {
                RelativePath = relativePath;
                SizeBytes = sizeBytes;
                Sha256 = sha256;
            }

            internal string RelativePath { get; private set; }
            internal long SizeBytes { get; private set; }
            internal string Sha256 { get; private set; }
        }
    }
}
