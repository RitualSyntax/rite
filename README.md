# Rite

A daily planner in the same style as Forge, Tithe and Grimoire. Everything is saved on your phone.

## What it does

- **Today**: overdue tasks, today's tasks (timed ones first), and a "From your apps" strip showing today's meals from Grimoire, money owed in Tithe, and a button to open Forge.
- **Upcoming**: the next two weeks day by day, including the future days your repeating tasks fall on.
- **Lists**: Inbox, Home, Work, Life, plus any lists you add. Your habits and repeating tasks are shown together here too.
- **Quick add**: type naturally and it works out the date, time, repeat and list. A preview under the box shows what it understood before you press Enter.
  - `dentist fri 3pm`
  - `bins every tue 8pm`
  - `gym every mon wed thu`
  - `pay rent on the 1st every month`
  - `call accountant tomorrow #work !` (the `!` means important)
  - `renew passport 12 march`
- **Repeats and streaks**: ticking off a repeating task moves it to its next date and counts how many times in a row you've done it.
- **Undo**: if you tick or delete something by mistake, tap Undo.

## Reminders (optional, but this is what makes it useful)

Rite uses your Google script, the same one as Tithe and Grimoire, so reminders still arrive when Rite is closed:

- **Timed tasks go into a "Rite" Google Calendar** with a notification on the dot, so your phone buzzes like any calendar event.
- **Morning email**: a list of today's tasks and anything overdue, at 7am (you can change the time in settings).

To switch it on, update the script again. It's the same steps as last time:

1. In script.google.com, open your project and **copy your token** from line 4.
2. Replace all the code with the new `mail-script/Code.gs` from the Tithe repo, then put your token back on line 4 and save.
3. Pick **authorise** in the dropdown and click **Run**. Allow the new permissions: Calendar, and "run when you're not there" for the morning email.
4. Go to **Deploy → Manage deployments → pencil → New version → Deploy**.
5. In Rite's settings, put in your email, then tap **Sync now**.

In the Google Calendar app, check the "Rite" calendar is ticked so its notifications show.
