# 1.1.2 workflow and long-audio repair

## Keep/remove decisions

| Item | Decision and reason |
| --- | --- |
| Reference loudness-matched A/B | Optional for comparing candidates or diagnosing issues. A reference is not required to deliver an accepted mix. Match segment and loudness when comparing. |
| cover_qc | Keep optional diagnostics; these complement, rather than duplicate, core input/model/output checks. Spectral centroid is a spectral description, not proof of voice identity. |
| cover_release | Keep optional local MP3/tag packaging. Do not encode an already acceptable file again. Any chosen encoder still needs decoded duration, finite-value and true-peak checks. This tool does not publish online. |
| Manual phrase tuning / automation | Remove from default completion requirements. These are manual production options, not implemented automatic stages; use only for a specific observed problem with authorization. |
| Historical helper scripts | Remove six unused registry entries: voicedCheck, crackFix, instProfile, shiftVerify, abGeneric, leadEqProbe. No user script/data is deleted. Optional/conditional scripts no longer block default doctor. A requested tool still fails clearly if its script is missing. |
| Core safeguards | Keep actual model/config, source/output provenance, fresh output, duration, finite audio, clipping/true peak and error/WARN checks plus separate user listening acceptance. No automatic tuning loop or quality guarantee. |

The default recipe remains two-level separation, baseline lead conversion, original harmony, standard complete mix/master, technical checks and user listening. Non-octave key changes still require accompaniment/harmony shift.

## Included 1.1.1 repair

Baseline inputs longer than 30 seconds use bounded overlapping render windows with context and crossfades. The original renderer and selected model load once. Full output preserves the original sample timeline. Short inputs keep the original route. Process root-cause errors (including CUDA OOM) and secondary separation failures reach the caller.

Historical full-song evidence: before repair a 286.720-second input failed with CUDA OOM. The repaired real apply/register/execute route completed 15 windows and a full mix. Five-second GPU samples peaked at 2436 MiB; conversion took about 81.5 seconds. This is one-machine evidence, not a universal memory bound. The user accepted the resulting master with no obvious abnormality. Metrics alone did not establish listening quality. That execution used an isolated tool host, not independent proof of DSH UI loading.

The prior accepted render is not repeated merely for this workflow cleanup. No model, song, personal trace or host-specific configuration is included. CPU regressions check implementation and contracts, not subjective quality. External MSST, DDSP and compatible mix/verify implementations remain required and are not bundled. Optional QC/cut/release scripts are also external and run only on request.

## Reproduce checks

Run `npm test` (15), `python -B test/adapter-cpu.py` (6), `python -B test/long-audio-cpu.py` (6), `npm run test:workflow` (7), and `npm run test:package`. The original requested 27-count baseline is the 15 + 6 + 6 regression set; the additional real external mix test contributes 3 more when run with `python -B test/mix-cpu.py --mix-dir <compatible-project>`. The earlier 1.1.0 total was 12 JS + 6 adapter + 3 mix = 21; counts are stated explicitly to avoid conflating suites. CI runs portable CPU suites on Windows and Linux; external real mix and GPU are not CI claims.

Removed the obsolete song-specific `test:e2e` and its npm command. Portable regression tests replace its stale-output success claims; the old file remains recoverable in Git and the local backup.
