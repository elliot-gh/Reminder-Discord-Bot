export type ReminderConfig = {
    mongoDb: {
        url: string,
        user: string,
        password: string,
        agendaCollection: string
    }
}
