# Reminder-Discord-Bot

A Discord bot built on [discord.js](https://discord.js.org/) that adds a reminder system with support for context menu targeting on a message. The reminder system uses [agenda](https://github.com/agenda/agenda), so MongoDB is required.

## Instructions

1. Please look at [Discord-Bot-Parent](https://github.com/elliot-gh/Discord-Bot-Parent) to setup the main parent project
2. Copy `config.example.yaml` as `config.yaml` and edit as appropriate.
3. Run parent

## Commands

- `/reminder create`: Creates a reminder.
- `/reminder list`: Lists all reminders, allowing deletion.
- `Apps -> Create reminder`: Creates a reminder on a specific message.

## License

GNU GPL v3.0
