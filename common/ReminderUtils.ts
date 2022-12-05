import { format } from "node:util";
import { Agenda } from "agenda";

let initOnce = false; // whether shutdown handlers are setup, only done if createAgenda() is called

const agendaInstances: { [collection: string]: Agenda } = {};

/**
 * Creates an Agenda object, then sets up shutdown handlers. The Agenda object is NOT started.
 * https://www.npmjs.com/package/agenda/
 * @param url The MongoDB URL
 * @param username The MongoDB username
 * @param password The MongoDB password
 * @param collection The MongoDB collection name
 * @returns A started Agenda object
 */
export async function createAgenda(url: string, username: string, password: string, collection: string): Promise<Agenda> {
    if (collection in agendaInstances) {
        console.log(`[ReminderUtils] found existing agenda for collection name ${collection}`);
        return agendaInstances[collection];
    }

    console.log(`[ReminderUtils] creating new agenda for collection name ${collection}`);

    const fullUrl = format(url,
        encodeURIComponent(username),
        encodeURIComponent(password));
    const newAgenda = new Agenda({
        db: {
            address: fullUrl,
            collection: collection
        }
    });

    agendaInstances[collection] = newAgenda;

    if (!initOnce) {
        initOnce = true;
        process.on("SIGTERM", handleAgendaShutdown);
        process.on("SIGINT", handleAgendaShutdown);
        process.on("SIGHUP", handleAgendaShutdown);
    }

    return newAgenda;
}

function handleAgendaShutdown() {
    const shutdownPromises = [];
    console.log("[ReminderUtils] Got shutdown signal, shutting down all Agenda instances");
    for (const collection in agendaInstances) {
        console.log(`[ReminderUtils] Shutting down Agenda instance for collection ${collection}`);
        const agenda = agendaInstances[collection];
        shutdownPromises.push(agenda.stop());
    }

    Promise.allSettled(shutdownPromises)
        .then(() => {
            console.error(`[ReminderUtils] handleAgendaShutdown() exitCode: ${process.exitCode}`);
            process.exit(process.exitCode);
        })
        .catch(() => {
            console.error(`[ReminderUtils] handleAgendaShutdown() exitCode: ${process.exitCode}`);
            process.exit(process.exitCode);
        });
}