# PieBox USSD service

This directory is an independent Node.js app. Deploy it as a **separate Heroku app** using this directory as the app root. It has no database; it calls PieBox Main Backend over HTTPS.

Set the variables in `.env.example` as Heroku config vars. `ADAPTER_TOKEN` must equal the Main Backend value. Point the Africa's Talking USSD callback URL to:

`https://<ussd-app-domain>/webhooks/africastalking/ussd/<USSD_WEBHOOK_SECRET>`

For local use, run `node --env-file=.env server.js`. The sandbox USSD channel is tested in the Africa's Talking simulator. The configured admin number `+255759637644` is the only permitted user by default. The final USSD response says an action was *queued*; the Main Backend sends the result by SMS after a device/agent reports it.

Menu `4 → 1` requests a fixed TZS 1,000 Airtime reward for the same admin number. Enable `AIRTIME_REWARD_ENABLED=true` on the Main Backend only when `SIMULATION_MODE=true` and `AT_USERNAME=sandbox`; Africa's Talking's initial acceptance is not final delivery.
