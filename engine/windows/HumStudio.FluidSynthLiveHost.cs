using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

internal static class FluidSynthNative
{
    private const string LibraryName = "libfluidsynth-3.dll";

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr new_fluid_settings();

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void delete_fluid_settings(IntPtr settings);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    internal static extern int fluid_settings_setstr(IntPtr settings, string name, string value);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    internal static extern int fluid_settings_setnum(IntPtr settings, string name, double value);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr new_fluid_synth(IntPtr settings);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void delete_fluid_synth(IntPtr synth);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    internal static extern int fluid_synth_sfload(IntPtr synth, string fileName, int resetPresets);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int fluid_synth_program_select(
        IntPtr synth,
        int channel,
        int soundFontId,
        int bank,
        int program);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int fluid_synth_noteon(IntPtr synth, int channel, int key, int velocity);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int fluid_synth_noteoff(IntPtr synth, int channel, int key);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int fluid_synth_all_notes_off(IntPtr synth, int channel);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int fluid_synth_all_sounds_off(IntPtr synth, int channel);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr new_fluid_audio_driver(IntPtr settings, IntPtr synth);

    [DllImport(LibraryName, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void delete_fluid_audio_driver(IntPtr driver);
}

internal sealed class FluidSynthLiveHost : IDisposable
{
    private const int Channel = 0;
    private IntPtr audioDriver;
    private IntPtr settings;
    private IntPtr synth;

    internal FluidSynthLiveHost(
        string soundFontPath,
        int bank,
        int program,
        double gain,
        int sampleRate)
    {
        settings = FluidSynthNative.new_fluid_settings();
        if (settings == IntPtr.Zero)
        {
            throw new InvalidOperationException("FluidSynth settings could not be created.");
        }

        RequireSuccess(
            FluidSynthNative.fluid_settings_setstr(settings, "audio.driver", "dsound"),
            "DirectSound audio driver could not be selected.");
        RequireSuccess(
            FluidSynthNative.fluid_settings_setnum(settings, "synth.sample-rate", sampleRate),
            "FluidSynth sample rate could not be configured.");
        RequireSuccess(
            FluidSynthNative.fluid_settings_setnum(settings, "synth.gain", gain),
            "FluidSynth gain could not be configured.");

        synth = FluidSynthNative.new_fluid_synth(settings);
        if (synth == IntPtr.Zero)
        {
            throw new InvalidOperationException("FluidSynth could not be created.");
        }

        int soundFontId = FluidSynthNative.fluid_synth_sfload(synth, soundFontPath, 1);
        if (soundFontId < 0)
        {
            throw new InvalidOperationException("The selected SoundFont could not be loaded.");
        }

        RequireSuccess(
            FluidSynthNative.fluid_synth_program_select(
                synth,
                Channel,
                soundFontId,
                bank,
                program),
            "The selected SoundFont Bank and Program could not be activated.");

        audioDriver = FluidSynthNative.new_fluid_audio_driver(settings, synth);
        if (audioDriver == IntPtr.Zero)
        {
            throw new InvalidOperationException("The DirectSound output device could not be opened.");
        }
    }

    internal void NoteOn(int pitch, int velocity)
    {
        RequireSuccess(
            FluidSynthNative.fluid_synth_noteon(synth, Channel, pitch, velocity),
            "FluidSynth rejected Note On.");
    }

    internal void NoteOff(int pitch)
    {
        FluidSynthNative.fluid_synth_noteoff(synth, Channel, pitch);
    }

    internal void AllNotesOff()
    {
        if (synth == IntPtr.Zero)
        {
            return;
        }

        FluidSynthNative.fluid_synth_all_notes_off(synth, Channel);
        FluidSynthNative.fluid_synth_all_sounds_off(synth, Channel);
    }

    public void Dispose()
    {
        AllNotesOff();

        if (audioDriver != IntPtr.Zero)
        {
            FluidSynthNative.delete_fluid_audio_driver(audioDriver);
            audioDriver = IntPtr.Zero;
        }

        if (synth != IntPtr.Zero)
        {
            FluidSynthNative.delete_fluid_synth(synth);
            synth = IntPtr.Zero;
        }

        if (settings != IntPtr.Zero)
        {
            FluidSynthNative.delete_fluid_settings(settings);
            settings = IntPtr.Zero;
        }
    }

    private static void RequireSuccess(int result, string message)
    {
        if (result == 0)
        {
            return;
        }

        throw new InvalidOperationException(message);
    }
}

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length != 6)
        {
            WriteError(
                "ARGUMENTS_INVALID",
                "Expected SoundFont path, Bank, Program, Gain, Sample Rate, and Parent Process ID.");
            return 2;
        }

        int bank;
        int parentProcessId;
        int program;
        int sampleRate;
        double gain;

        if (!Int32.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out bank) ||
            bank < 0 || bank > 16383 ||
            !Int32.TryParse(args[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out program) ||
            program < 0 || program > 127 ||
            !Double.TryParse(args[3], NumberStyles.Float, CultureInfo.InvariantCulture, out gain) ||
            gain <= 0 || gain > 10 ||
            !Int32.TryParse(args[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out sampleRate) ||
            sampleRate < 8000 || sampleRate > 192000 ||
            !Int32.TryParse(args[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out parentProcessId) ||
            parentProcessId <= 0)
        {
            WriteError("ARGUMENTS_INVALID", "FluidSynth Live Host arguments are invalid.");
            return 2;
        }

        try
        {
            StartParentWatchdog(parentProcessId);

            using (FluidSynthLiveHost host = new FluidSynthLiveHost(
                args[0], bank, program, gain, sampleRate))
            {
                Console.Out.WriteLine("READY");
                Console.Out.Flush();
                RunCommandLoop(host);
            }

            return 0;
        }
        catch (Exception error)
        {
            WriteError("LIVE_HOST_FAILED", error.Message);
            return 1;
        }
    }

    private static void StartParentWatchdog(int parentProcessId)
    {
        Thread watchdog = new Thread(() =>
        {
            try
            {
                using (Process parent = Process.GetProcessById(parentProcessId))
                {
                    parent.WaitForExit();
                }
            }
            catch (Exception)
            {
                // Fail closed when the parent is gone or cannot be monitored.
            }

            Environment.Exit(0);
        });
        watchdog.IsBackground = true;
        watchdog.Name = "HumStudio FluidSynth Parent Watchdog";
        watchdog.Start();
    }

    private static void RunCommandLoop(FluidSynthLiveHost host)
    {
        string line;

        while ((line = Console.In.ReadLine()) != null)
        {
            string[] parts = line.Split('\t');

            if (parts.Length == 1 && parts[0] == "STOP")
            {
                return;
            }

            if (parts.Length == 1 && parts[0] == "ALL_NOTES_OFF")
            {
                host.AllNotesOff();
                continue;
            }

            int pitch;
            if (parts.Length == 2 && parts[0] == "NOTE_OFF" &&
                Int32.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pitch) &&
                pitch >= 0 && pitch <= 127)
            {
                host.NoteOff(pitch);
                continue;
            }

            int velocity;
            if (parts.Length == 3 && parts[0] == "NOTE_ON" &&
                Int32.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pitch) &&
                pitch >= 0 && pitch <= 127 &&
                Int32.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out velocity) &&
                velocity >= 1 && velocity <= 127)
            {
                host.NoteOn(pitch, velocity);
                continue;
            }

            WriteError("COMMAND_INVALID", "FluidSynth Live Host received an invalid command.");
        }
    }

    private static void WriteError(string code, string message)
    {
        string safeMessage = (message ?? "Unknown error")
            .Replace('\t', ' ')
            .Replace('\r', ' ')
            .Replace('\n', ' ');
        Console.Error.WriteLine("ERROR\t" + code + "\t" + safeMessage);
        Console.Error.Flush();
    }
}
