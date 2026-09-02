import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(
  new URL('./aceStepWorkerHost.py', import.meta.url),
  'utf8',
);
const providerCheckout = process.env.HUMSTUDIO_ACE_STEP_PROVIDER_CHECKOUT;
const PINNED_PROVIDER_REVISION = 'dce621408bee8c31b4fcf4811682eb9359e1bc94';

describe('ACE-Step Guide Audio source profile', () => {
  it('accepts native SA3 44.1 kHz Guides and existing ACE 48 kHz Guides', () => {
    expect(workerSource).toMatch(
      /SUPPORTED_GUIDE_SAMPLE_RATES\s*=\s*frozenset\(\{44_100,\s*SAMPLE_RATE\}\)/,
    );
    expect(workerSource).toMatch(
      /sample_rate\s+not\s+in\s+SUPPORTED_GUIDE_SAMPLE_RATES/,
    );
  });

  it('keeps generated ACE output locked to the 48 kHz production profile', () => {
    const outputValidation = workerSource.slice(
      workerSource.indexOf('def validate_saved_output_samples('),
      workerSource.indexOf('\ndef inspect_wave('),
    );

    expect(outputValidation).toMatch(/sample_rate\s*!=\s*SAMPLE_RATE/);
    expect(outputValidation).not.toContain('SUPPORTED_GUIDE_SAMPLE_RATES');
  });

  it('passes the exact Guide path, official Base quality profile, and disabled LM/CoT controls upstream', () => {
    const generationCall = workerSource.slice(
      workerSource.indexOf('params = GenerationParams('),
      workerSource.indexOf('result = generate_music('),
    );

    expect(generationCall).toContain('src_audio=str(guide_path)');
    expect(generationCall).toContain(
      'vocal_language=parameters["vocalLanguage"]',
    );
    expect(generationCall).toContain('task_type="lego"');
    expect(generationCall).toContain('use_adg=USE_ADG');
    expect(generationCall).toContain('cfg_interval_start=CFG_INTERVAL_START');
    expect(generationCall).toContain('cfg_interval_end=CFG_INTERVAL_END');
    expect(generationCall).toContain('shift=SHIFT');
    expect(generationCall).toContain('dcw_enabled=DCW_ENABLED');
    expect(generationCall).toContain('thinking=False');
    expect(generationCall).toContain('use_cot_metas=False');
    expect(generationCall).toContain('use_cot_caption=False');
    expect(generationCall).toContain('use_cot_lyrics=False');
    expect(generationCall).toContain('use_cot_language=False');
    expect(generationCall).not.toContain('audio_codes=');
  });

  it('locks Base generation to the official high-quality profile without Turbo-only DCW', () => {
    expect(workerSource).toMatch(/INFERENCE_STEPS\s*=\s*64/);
    expect(workerSource).toMatch(/GUIDANCE_SCALE\s*=\s*8\.0/);
    expect(workerSource).toMatch(/USE_ADG\s*=\s*True/);
    expect(workerSource).toMatch(/SHIFT\s*=\s*3\.0/);
    expect(workerSource).toMatch(/DCW_ENABLED\s*=\s*False/);
    expect(workerSource).toContain(
      'INSTRUCTION = "Generate the VOCALS track based on the audio context:"',
    );
  });

  it('scopes Git ownership trust to the exact pinned Provider checkout', () => {
    expect(workerSource).toContain('safe_directory = provider_root.as_posix()');
    expect(workerSource).toContain('f"safe.directory={safe_directory}"');
    expect(workerSource).not.toContain('git config --global');
  });

  it('uses the source-free Text to Music task with Project musical context', () => {
    const generationCall = workerSource.slice(
      workerSource.indexOf('params = GenerationParams('),
      workerSource.indexOf('result = generate_music('),
    );

    expect(workerSource).toContain('TEXT_TO_MUSIC_TASK_ID = "text-to-music"');
    expect(generationCall).toContain('task_type="text2music"');
    expect(generationCall).toContain('src_audio=None');
    expect(generationCall).toContain('bpm=parameters["bpm"]');
    expect(generationCall).toContain('keyscale=parameters["keyscale"]');
    expect(generationCall).toContain('timesignature=parameters["timesignature"]');
    expect(generationCall).toContain('instrumental=parameters["instrumental"]');
  });

  it('uses pinned Remix Cover strengths and disables LM thinking', () => {
    const generationCall = workerSource.slice(
      workerSource.indexOf('params = GenerationParams('),
      workerSource.indexOf('result = generate_music('),
    );

    expect(workerSource).toContain('COVER_TASK_ID = "audio-cover"');
    expect(generationCall).toContain('task_type="cover"');
    expect(generationCall).toContain('audio_cover_strength=parameters["audioCoverStrength"]');
    expect(generationCall).toContain('cover_noise_strength=parameters["coverNoiseStrength"]');
    expect(generationCall).toContain('src_audio=str(guide_path)');
    expect(generationCall).toContain('thinking=False');
  });

  it('labels provider ratio updates as estimated progress', () => {
    expect(workerSource).toContain('"accuracy": "ESTIMATED"');
    expect(workerSource).toContain('progress=report_progress');
    expect(workerSource).toContain('"event": "progress"');
    expect(workerSource).not.toContain('"currentStep"');
    expect(workerSource).toContain('PROTOCOL_OUTPUT = sys.stdout');
    expect(workerSource).toContain('PROTOCOL_OUTPUT.write(line)');
  });

  it.runIf(
    typeof providerCheckout === 'string' &&
      providerCheckout.length > 0 &&
      isAbsolute(providerCheckout)
  )(
    'verifies the pinned clean provider processes lego src_audio without an LM audio-code override',
    () => {
      const safeDirectory = providerCheckout.replaceAll('\\', '/');
      const head = execFileSync(
        'git',
        ['-c', `safe.directory=${safeDirectory}`, '-C', providerCheckout, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      ).trim();
      const status = execFileSync(
        'git',
        ['-c', `safe.directory=${safeDirectory}`, '-C', providerCheckout, 'status', '--short'],
        { encoding: 'utf8' },
      ).trim();
      const inference = readFileSync(join(providerCheckout, 'acestep', 'inference.py'), 'utf8');
      const sourceRequest = readFileSync(
        join(
          providerCheckout,
          'acestep',
          'core',
          'generation',
          'handler',
          'generate_music_request.py',
        ),
        'utf8',
      );
      const conditioningMasks = readFileSync(
        join(
          providerCheckout,
          'acestep',
          'core',
          'generation',
          'handler',
          'conditioning_masks.py',
        ),
        'utf8',
      );

      expect(head).toBe(PINNED_PROVIDER_REVISION);
      expect(status).toBe('');
      expect(inference).toContain(
        'use_lm = (params.thinking or need_lm_for_cot)',
      );
      expect(inference).toContain(
        'if lm_code and str(lm_code).strip():',
      );
      expect(sourceRequest).toContain('elif src_audio is not None:');
      expect(sourceRequest).toContain(
        'if self._has_non_empty_audio_codes(audio_code_string):',
      );
      expect(sourceRequest).toContain(
        'Audio codes provided, ignoring src_audio and using codes instead',
      );
      expect(sourceRequest).toContain(
        '[generate_music] Processing source audio...',
      );
      expect(sourceRequest).toContain(
        'processed_src_audio = self.process_src_audio(src_audio)',
      );
      expect(conditioningMasks).toContain(
        'is_lego = (task_type == "lego")',
      );
      expect(conditioningMasks).toContain(
        'src_latent = target_latents[i].clone()',
      );
      expect(conditioningMasks).toContain('if not is_lego:');
    },
  );
});
