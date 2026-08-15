# Windows packaging and install guide

## Build

```powershell
npm install
npm run package:win
```

This produces:

```text
 dist-exe/tally-backend.exe
```

## Run directly

```powershell
.
\dist-exe\tally-backend.exe
```

## Install as a Windows service

1. Copy the exe and your .env file to a folder, for example:

```text
C:\Program Files\TallyConnector
```

2. Run the installer script from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-service.ps1
```

3. Verify:

```powershell
http://localhost:3000/api/health
```

## Important

- Tally must have "Act as Server" enabled on port 9001.
- Set TALLY_HOST to the Tally machine IP or 127.0.0.1 if local.
- The app expects a .env file next to the exe.
