using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace HumStudio.Windows
{
    internal static class DirectoryPickerProgram
    {
        private const int CancelExitCode = 2;
        private const int ErrorCancelled = unchecked((int)0x800704C7);

        [STAThread]
        private static int Main(string[] args)
        {
            string resultFilePath = null;

            try
            {
                resultFilePath = GetResultFilePath(args);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                if (Array.IndexOf(args, "--smoke-test") >= 0)
                {
                    VerifyOwnerWindowIcon();
                    VerifyCommonItemDialogAvailability();
                    WriteResult(resultFilePath, "READY");
                    return 0;
                }

                string selectedPath = null;
                int dialogResult = ErrorCancelled;

                using (var owner = CreateOwnerWindow())
                {
                    owner.Shown += delegate
                    {
                        owner.BeginInvoke((MethodInvoker)delegate
                        {
                            owner.Activate();
                            owner.BringToFront();
                            NativeMethods.SetForegroundWindow(owner.Handle);

                            dialogResult = ShowDirectoryPicker(owner.Handle, out selectedPath);
                            owner.Close();
                        });
                    };

                    Application.Run(owner);
                }

                if (dialogResult == ErrorCancelled)
                {
                    WriteResult(resultFilePath, "CANCELED");
                    return CancelExitCode;
                }

                Marshal.ThrowExceptionForHR(dialogResult);

                if (String.IsNullOrWhiteSpace(selectedPath))
                {
                    throw new InvalidOperationException(
                        "Windows returned an empty Project Root path."
                    );
                }

                WriteResult(resultFilePath, "SELECTED\n" + selectedPath);
                return 0;
            }
            catch (Exception error)
            {
                if (!String.IsNullOrWhiteSpace(resultFilePath))
                {
                    try
                    {
                        WriteResult(resultFilePath, "ERROR\n" + error.Message);
                    }
                    catch
                    {
                        // The process exit code remains the final fallback when result IPC fails.
                    }
                }

                return 1;
            }
        }

        private static string GetResultFilePath(string[] args)
        {
            var optionIndex = Array.IndexOf(args, "--result-file");

            if (
                optionIndex < 0 ||
                optionIndex + 1 >= args.Length ||
                String.IsNullOrWhiteSpace(args[optionIndex + 1])
            )
            {
                throw new ArgumentException(
                    "The Windows directory picker requires one result file path."
                );
            }

            return Path.GetFullPath(args[optionIndex + 1]);
        }

        private static void WriteResult(string resultFilePath, string result)
        {
            File.WriteAllText(resultFilePath, result, new UTF8Encoding(false));
        }

        private static Form CreateOwnerWindow()
        {
            Icon ownerIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

            if (ownerIcon == null)
            {
                throw new InvalidOperationException(
                    "The ElpisDAW Project Root window icon could not be loaded."
                );
            }

            try
            {
                var owner = new Form
                {
                    AutoScaleMode = AutoScaleMode.Dpi,
                    BackColor = Color.FromArgb(25, 28, 33),
                    ClientSize = new Size(420, 112),
                    FormBorderStyle = FormBorderStyle.FixedDialog,
                    Icon = ownerIcon,
                    MaximizeBox = false,
                    MinimizeBox = true,
                    ShowIcon = true,
                    ShowInTaskbar = true,
                    StartPosition = FormStartPosition.CenterScreen,
                    Text = "ElpisDAW Project Root",
                    TopMost = true
                };

                owner.Disposed += delegate { ownerIcon.Dispose(); };

                owner.Controls.Add(new Label
                {
                    AutoSize = false,
                    Dock = DockStyle.Fill,
                    Font = new Font("Segoe UI", 10F, FontStyle.Regular),
                    ForeColor = Color.White,
                    Padding = new Padding(24),
                    Text = "Opening the Windows folder picker...\r\n" +
                           "If another app is in front, select ElpisDAW Project Root on the taskbar.",
                    TextAlign = ContentAlignment.MiddleLeft
                });

                return owner;
            }
            catch
            {
                ownerIcon.Dispose();
                throw;
            }
        }

        private static int ShowDirectoryPicker(IntPtr ownerHandle, out string selectedPath)
        {
            selectedPath = null;
            IFileOpenDialog dialog = null;
            IShellItem result = null;

            try
            {
                dialog = (IFileOpenDialog)new FileOpenDialog();
                FileOpenOptions options;
                dialog.GetOptions(out options);
                dialog.SetOptions(
                    options |
                    FileOpenOptions.PickFolders |
                    FileOpenOptions.ForceFileSystem |
                    FileOpenOptions.PathMustExist |
                    FileOpenOptions.NoChangeDirectory
                );
                dialog.SetTitle("Select ElpisDAW Project Root");
                dialog.SetOkButtonLabel("Select Folder");

                var showResult = dialog.Show(ownerHandle);

                if (showResult < 0)
                {
                    return showResult;
                }

                dialog.GetResult(out result);
                IntPtr pathPointer;
                result.GetDisplayName(ShellItemDisplayName.FileSystemPath, out pathPointer);

                try
                {
                    selectedPath = Marshal.PtrToStringUni(pathPointer);
                }
                finally
                {
                    Marshal.FreeCoTaskMem(pathPointer);
                }

                return showResult;
            }
            finally
            {
                if (result != null)
                {
                    Marshal.FinalReleaseComObject(result);
                }

                if (dialog != null)
                {
                    Marshal.FinalReleaseComObject(dialog);
                }
            }
        }

        private static void VerifyCommonItemDialogAvailability()
        {
            object dialog = null;

            try
            {
                dialog = new FileOpenDialog();
            }
            finally
            {
                if (dialog != null)
                {
                    Marshal.FinalReleaseComObject(dialog);
                }
            }
        }

        private static void VerifyOwnerWindowIcon()
        {
            using (var owner = CreateOwnerWindow())
            {
                if (owner.Icon == null || owner.Icon.Handle == IntPtr.Zero)
                {
                    throw new InvalidOperationException(
                        "The ElpisDAW Project Root window icon is unavailable."
                    );
                }
            }
        }
    }

    internal static class NativeMethods
    {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetForegroundWindow(IntPtr windowHandle);
    }

    [Flags]
    internal enum FileOpenOptions : uint
    {
        PickFolders = 0x00000020,
        ForceFileSystem = 0x00000040,
        NoChangeDirectory = 0x00000008,
        PathMustExist = 0x00000800
    }

    internal enum ShellItemDisplayName : uint
    {
        FileSystemPath = 0x80058000
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    internal class FileOpenDialog
    {
    }

    [ComImport]
    [Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOpenDialog
    {
        [PreserveSig]
        int Show(IntPtr parent);

        void SetFileTypes(uint fileTypeCount, IntPtr filterSpec);

        void SetFileTypeIndex(uint fileTypeIndex);

        void GetFileTypeIndex(out uint fileTypeIndex);

        void Advise(IntPtr events, out uint cookie);

        void Unadvise(uint cookie);

        void SetOptions(FileOpenOptions options);

        void GetOptions(out FileOpenOptions options);

        void SetDefaultFolder(IShellItem shellItem);

        void SetFolder(IShellItem shellItem);

        void GetFolder(out IShellItem shellItem);

        void GetCurrentSelection(out IShellItem shellItem);

        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);

        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);

        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);

        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);

        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);

        void GetResult(out IShellItem shellItem);

        void AddPlace(IShellItem shellItem, int alignment);

        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);

        void Close(int result);

        void SetClientGuid(ref Guid clientGuid);

        void ClearClientData();

        void SetFilter(IntPtr filter);

        void GetResults(out IntPtr shellItems);

        void GetSelectedItems(out IntPtr shellItems);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(
            IntPtr bindContext,
            ref Guid bindHandlerId,
            ref Guid interfaceId,
            out IntPtr interfacePointer
        );

        void GetParent(out IShellItem parent);

        void GetDisplayName(ShellItemDisplayName displayName, out IntPtr name);

        void GetAttributes(uint attributeMask, out uint attributes);

        void Compare(IShellItem shellItem, uint hint, out int order);
    }
}
