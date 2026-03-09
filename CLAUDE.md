# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Physicker

Physicker is a physician productivity app prototype (no real patient data). A physician records a patient conversation on their mobile device; the app transcribes it and generates a structured clinical summary.

Core pipeline: **audio recording → OpenAI Whisper API (transcription) → Claude API (clinical summary) → display summary**

## Tech Stack

- **Framework:** Expo + React Native (mobile, iOS/Android)
- **Transcription:** OpenAI Whisper API
- **Summary generation:** Anthropic Claude API
- **Prototype only:** no real patient data, no HIPAA obligations in this phase

## Development Commands

```bash
npx expo start          # Start the Expo dev server
npx expo start --ios    # Run on iOS simulator
npx expo start --android # Run on Android emulator
npx expo run:ios        # Native build for iOS
npx expo run:android    # Native build for Android
```

## Architecture

The app follows a linear pipeline:

1. **Audio recording** — uses Expo AV (`expo-av`) to capture microphone input and produce an audio file
2. **Transcription** — audio file is posted to the OpenAI Whisper API; returns a transcript string
3. **Clinical summary** — transcript is sent to the Claude API with a prompt that structures it into clinical note format (e.g., SOAP or similar)
4. **Display** — structured summary is rendered in the app for physician review

API keys for OpenAI and Anthropic must be configured (e.g., via environment variables or a local config file not committed to git).

## Git LFS

Git LFS is configured. Large binary assets should be tracked with LFS rather than committed directly.
