import { format } from "node:util";
import { ContextMenuCommandBuilder, SlashCommandBuilder } from "@discordjs/builders";
import { ActionRowBuilder, ApplicationCommandType, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction,
    Client, ColorResolvable, CommandInteraction, EmbedBuilder, GatewayIntentBits,
    MessageContextMenuCommandInteraction, ModalBuilder, ModalSubmitInteraction, TextInputBuilder,
    TextInputStyle, WebhookEditMessageOptions } from "discord.js";
import { BotInterface } from "../../BotInterface";
import { Agenda, Job } from "agenda";
import { readYamlConfig } from "../../ConfigUtils";
import { ReminderConfig } from "./ReminderConfig";
import { ReminderJobData } from "./ReminderJobData";
import { ObjectId } from "mongodb";

export class ReminderBot implements BotInterface {
    private static readonly CONTEXT_CREATE_NAME = "Create reminder";
    private static readonly SUBCMD_CREATE = "create";
    private static readonly SUBCMD_LIST = "list";
    private static readonly CREATE_MODAL_PREFIX = "ReminderBot_createReminderModal__";
    private static readonly CREATE_MODAL_SUFFIX_NOREPLY = "noreply";
    private static readonly INPUT_TIME_ID = "ReminderBot_timeTextInput";
    private static readonly INPUT_DESCRIPTION_ID = "ReminderBot_descriptionInput";
    private static readonly MAX_DESCRIPTION_LENGTH = 80;
    private static readonly AGENDA_JOB_REMINDER = "reminder";
    private static readonly BTN_PREV = "ReminderBot_btnPrev";
    private static readonly BTN_NEXT = "ReminderBot_btnNext";
    private static readonly BTN_DEL_PROMPT_PREFIX = "ReminderBot_btnDeletePrompt__";
    private static readonly BTN_DEL_CONFIRM_PREFIX = "ReminderBot_btnDeleteConfirm__";
    private static readonly BTN_DEL_CANCEL_PREFIX = "ReminderBot_btnDeleteCancel__";

    intents: GatewayIntentBits[];
    commands: (SlashCommandBuilder | ContextMenuCommandBuilder)[];
    private slashReminder: SlashCommandBuilder;
    private contextReminder: ContextMenuCommandBuilder;
    private static agenda: Agenda;
    private static client: Client;

    constructor() {
        this.intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
        this.slashReminder = new SlashCommandBuilder()
            .setName("reminder")
            .setDescription("Create, delete, or view your reminders.")
            .addSubcommand(subcommand =>
                subcommand
                    .setName(ReminderBot.SUBCMD_CREATE)
                    .setDescription("Creates a reminder. If used in a reply, will remind you about that message.")
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName(ReminderBot.SUBCMD_LIST)
                    .setDescription("Lists your reminders, which also allows you to delete them.")
            ) as SlashCommandBuilder;
        this.contextReminder = new ContextMenuCommandBuilder()
            .setName(ReminderBot.CONTEXT_CREATE_NAME)
            .setType(ApplicationCommandType.Message) as ContextMenuCommandBuilder;
        this.commands = [this.slashReminder, this.contextReminder];
    }

    async init(): Promise<string | null> {
        try {
            if (ReminderBot.agenda !== undefined) {
                const error = "[ReminderBot] ReminderBot.agenda already exists!";
                console.error(error);
                throw new Error(error);
            }

            const config = await readYamlConfig<ReminderConfig>(import.meta, "config.yaml");
            const fullUrl = format(config.mongoDb.url,
                encodeURIComponent(config.mongoDb.user),
                encodeURIComponent(config.mongoDb.password));
            ReminderBot.agenda = new Agenda({
                db: {
                    address: fullUrl,
                    collection: config.mongoDb.agendaCollection
                }
            });

            await ReminderBot.agenda.start();

            ReminderBot.agenda.define(ReminderBot.AGENDA_JOB_REMINDER, ReminderBot.handleReminderJob);

            const agendaShutdown = () => {
                ReminderBot.agenda.stop()
                    .then(() => {
                        process.exit(process.exitCode);
                    })
                    .catch(() => {
                        process.exit(process.exitCode);
                    });
            };
            process.on("SIGTERM", agendaShutdown);
            process.on("SIGINT", agendaShutdown);

            return null;
        } catch (error) {
            const errMsg = `[ReminderBot] Error in init(): ${error}`;
            console.error(errMsg);
            return errMsg;
        }
    }

    async processCommand(interaction: CommandInteraction): Promise<void> {
        if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) {
            return;
        } else if (interaction.user.id === ReminderBot.client.user!.id) {
            return;
        }

        try {
            console.log(`[ReminderBot] got interaction: ${interaction}`);
            if (interaction.isChatInputCommand()) {
                if (interaction.commandName === this.slashReminder.name) {
                    switch(interaction.options.getSubcommand()) {
                        case ReminderBot.SUBCMD_CREATE:
                            await this.handleSlashCreate(interaction);
                            break;
                        case ReminderBot.SUBCMD_LIST:
                            await this.handleSlashList(interaction);
                            break;
                    }
                }
            } else if (interaction.isMessageContextMenuCommand()) {
                if (interaction.commandName === this.contextReminder.name) {
                    await this.handleContextCreate(interaction);
                }
            }
        } catch (error) {
            console.error(`[ReminderBot] Got error: ${error}`);
        }
    }

    async useClient(client: Client): Promise<void> {
        ReminderBot.client = client;
        client.on("interactionCreate", async (interaction) => {
            if (interaction.user.id === client.user!.id) {
                return;
            }

            if (interaction.isModalSubmit()) {
                console.log(`[ReminderBot] Got modal submission: ${interaction.customId}`);
                await this.handleCreateModalSubmit(interaction);
            }

            if (interaction.isButton()) {
                console.log(`[ReminderBot] Got button click: ${interaction.customId}`);
                await this.handleButtonClick(interaction);
            }
        });
    }

    static async handleReminderJob(job: Job): Promise<void> {
        try {
            if (job.attrs.data === undefined || job.attrs.lastRunAt === undefined) {
                throw new Error(`[ReminderBot] Bad job data: ${job.toJSON()}`);
            }

            const data = job.attrs.data as ReminderJobData;
            const embed = await ReminderBot.createReminderEmbed("Reminder triggered", job.attrs.lastRunAt, data, 0xFFFFFF);
            const channel = await ReminderBot.client.channels.fetch(data.channelId);
            const user = await ReminderBot.client.users.fetch(data.userId);
            if (channel === null || !channel.isTextBased()) {
                const error = `[ReminderBot] Channel ID is unexpected: ${data.channelId}`;
                throw new Error(error);
            }

            await channel.send({
                content: user.toString(),
                embeds: [embed]
            });

            await job.remove();
        } catch (error) {
            const errStr = `[ReminderBot] Failed to finish reminder job: ${error}`;
            console.error(errStr);
            job.fail(errStr);
        }
    }

    async handleSlashCreate(interaction: ChatInputCommandInteraction): Promise<void> {
        console.log(`[ReminderBot] handleSlashCreate() from: ${interaction.user.id}`);
        const modal = ReminderBot.createQuoteModal(null);
        await interaction.showModal(modal);
    }

    async handleSlashList(interaction: ChatInputCommandInteraction): Promise<void> {
        console.log(`[ReminderBot] handleSlashList() from: ${interaction.user.id}`);
        const message = await ReminderBot.createReminderList(interaction.user.id, interaction.guildId!, 0);
        await interaction.reply(message);
    }

    async handleContextCreate(interaction: MessageContextMenuCommandInteraction): Promise<void> {
        const messageId = interaction.targetMessage.id;
        console.log(`[ReminderBot] handleContextCreate() from ${interaction.user.id} on ${messageId}`);
        const modal = ReminderBot.createQuoteModal(messageId);
        await interaction.showModal(modal);
    }

    async handleCreateModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
        if (!interaction.customId.startsWith(ReminderBot.CREATE_MODAL_PREFIX)) {
            return;
        }

        if (interaction.channelId === null || interaction.channel === null) {
            console.error(`[ReminderBot] Got null channelId: ${interaction.customId}, skipping`);
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        const timeStr = interaction.fields.getTextInputValue(ReminderBot.INPUT_TIME_ID);
        const description = interaction.fields.getTextInputValue(ReminderBot.INPUT_DESCRIPTION_ID);
        const messageId: string | null = interaction.customId.substring(ReminderBot.CREATE_MODAL_PREFIX.length);
        let messageUrl = null;
        if (messageId !== ReminderBot.CREATE_MODAL_SUFFIX_NOREPLY) {
            messageUrl = ReminderBot.createDiscordUrl(interaction.guildId!, interaction.channelId, messageId);
        }

        const jobData: ReminderJobData = {
            userId: interaction.user.id,
            channelId: interaction.channelId,
            guildId: interaction.guildId!,
            description: description,
            messageUrl: messageUrl!
        };

        console.log(`[ReminderBot] handleCreateModalSubmit() with info: ${JSON.stringify(jobData)}`);

        let newReminder;
        let date;
        try {
            newReminder = ReminderBot.agenda.create(ReminderBot.AGENDA_JOB_REMINDER, jobData);
            newReminder.schedule(timeStr);
            date = newReminder.attrs.nextRunAt;
            if (date == null) {
                throw Error("[ReminderBot] Got null or undefined date");
            }
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[ReminderBot] Error creating reminder: ${error}`);
                const errorEmbed = ReminderBot.createErrorEmbed("Failed to create reminder", error.message);
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
                return;
            }

            console.error(`[ReminderBot] Error creating reminder: ${error}`);
            const errorEmbed = ReminderBot.createErrorEmbed("Failed to create reminder", "unknown error");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            return;
        }

        try {
            await newReminder.save();
            const embed = await ReminderBot.createReminderEmbed("Created new reminder", date, jobData, 0x00FF00);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[ReminderBot] Error saving reminder: ${error}`);
                const errorEmbed = ReminderBot.createErrorEmbed("Failed to save reminder", error.message);
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
                return;
            }

            console.error(`[ReminderBot] Error saving reminder: ${error}`);
            const errorEmbed = ReminderBot.createErrorEmbed("Failed to save reminder", "unknown error");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            return;
        }
    }

    async handleButtonClick(interaction: ButtonInteraction): Promise<void> {
        const interactUser = interaction.user.id;
        const slashUser = interaction.message.interaction!.user.id;
        if (interactUser !== slashUser) {
            await interaction.update("");
            return;
        }

        const currentPos = ReminderBot.deserializeListString(interaction.message.embeds[0].title!);
        let newUpdate: WebhookEditMessageOptions | null = null;
        if (interaction.customId === ReminderBot.BTN_PREV) {
            newUpdate = await ReminderBot.createReminderList(interactUser, interaction.guildId!, currentPos - 1);
        } else if (interaction.customId === ReminderBot.BTN_NEXT) {
            newUpdate = await ReminderBot.createReminderList(interactUser, interaction.guildId!, currentPos + 1);
        } else if (interaction.customId.startsWith(ReminderBot.BTN_DEL_PROMPT_PREFIX)) {
            newUpdate = await ReminderBot.handleDeletePrompt(interaction);
        }  else if (interaction.customId.startsWith(ReminderBot.BTN_DEL_CONFIRM_PREFIX)) {
            await ReminderBot.handleDeleteConfirm(interaction, currentPos);
        } else if (interaction.customId.startsWith(ReminderBot.BTN_DEL_CANCEL_PREFIX)) {
            newUpdate = await ReminderBot.handleDeleteCancel(interaction);
        }

        if (newUpdate !== null) {
            await interaction.update(newUpdate);
        }

        return;
    }

    static async handleDeletePrompt(interaction: ButtonInteraction): Promise<WebhookEditMessageOptions> {
        console.log(`[ReminderBot] handleDeletePrompt() with customId: ${interaction.customId}`);
        const objId = ReminderBot.deserializeObjectId(interaction.customId).toHexString();

        const btnDelPrompt = this.createButtonDeletePrompt(objId).setDisabled(true);
        const btnConfirm = this.createButtonDeleteConfirm(objId);
        const btnCancel = this.createButtonDeleteCancel(objId);
        const rowNextPrev = this.createBackNextRow();
        const rowDel = new ActionRowBuilder().addComponents(btnDelPrompt, btnConfirm, btnCancel) as ActionRowBuilder<ButtonBuilder>;
        return {
            components: [rowNextPrev, rowDel]
        };
    }

    static async handleDeleteCancel(interaction: ButtonInteraction): Promise<WebhookEditMessageOptions> {
        console.log(`[ReminderBot] handleDeleteCancel() with customId: ${interaction.customId}`);
        const objId = ReminderBot.deserializeObjectId(interaction.customId).toHexString();

        const btnDelPrompt = this.createButtonDeletePrompt(objId);
        const rowNextPrev = this.createBackNextRow();
        const rowDel = new ActionRowBuilder().addComponents(btnDelPrompt) as ActionRowBuilder<ButtonBuilder>;
        return {
            components: [rowNextPrev, rowDel]
        };
    }

    static async handleDeleteConfirm(interaction: ButtonInteraction, currentPos: number): Promise<void> {
        console.log(`[ReminderBot] handleDeleteConfirm() with customId: ${interaction.customId}`);
        try {
            const objId = ReminderBot.deserializeObjectId(interaction.customId);
            const amountCanceled = await this.agenda.cancel({ _id: objId });
            if (amountCanceled === 0) {
                throw new Error("No jobs were deleted");
            }

            const embed = new EmbedBuilder()
                .setTitle("Deleted reminder")
                .setColor(0x00FF00);
            await interaction.update(await this.createReminderList(interaction.user.id, interaction.guildId!, currentPos - 1));
            await interaction.followUp({ embeds: [embed], ephemeral: true });
        } catch (error) {
            if (error instanceof Error) {
                const errStr = `[ReminderBot] Error deleting reminder: ${error}`;
                console.error(errStr);
                const errorEmbed = ReminderBot.createErrorEmbed("Failed to delete reminder", error.message);
                await interaction.update({ components: [] });
                await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
            } else {
                const errStr = `[ReminderBot] Unknown error while deleting reminder: ${error}`;
                console.error(errStr);
                throw new Error(errStr);
            }
        }
    }

    static createQuoteModal(messageId: string | null): ModalBuilder {
        console.log(`[ReminderBot] createQuoteModal() with messageId: ${messageId}`);
        const customId = ReminderBot.CREATE_MODAL_PREFIX + (messageId ?? ReminderBot.CREATE_MODAL_SUFFIX_NOREPLY);
        const modal = new ModalBuilder()
            .setCustomId(customId)
            .setTitle("Create a New Reminder");

        const timeInput = new TextInputBuilder()
            .setCustomId(ReminderBot.INPUT_TIME_ID)
            // eslint-disable-next-line quotes
            .setLabel('When ("4 hours", "12/31/2022 8:30pm", etc)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        const descriptionInput = new TextInputBuilder()
            .setCustomId(ReminderBot.INPUT_DESCRIPTION_ID)
            .setLabel("Reminder description")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(ReminderBot.MAX_DESCRIPTION_LENGTH);

        const firstActionRow = new ActionRowBuilder().addComponents(timeInput) as ActionRowBuilder<TextInputBuilder>;
        const secondActionRow = new ActionRowBuilder().addComponents(descriptionInput) as ActionRowBuilder<TextInputBuilder>;
        modal.addComponents(firstActionRow, secondActionRow);

        return modal;
    }

    static async createReminderEmbed(title: string, date: Date, data: ReminderJobData, color: ColorResolvable): Promise<EmbedBuilder> {
        const channel = await ReminderBot.client.channels.fetch(data.channelId);
        if (channel === null || !channel.isTextBased()) {
            const error = `[ReminderBot] Channel ID is unexpected: ${data.channelId}`;
            console.error(error);
            throw new Error(error);
        }

        const unixTime = Math.round(date.getTime() / 1000);
        const embed = new EmbedBuilder()
            .setTitle(title)
            .addFields(
                { name: "Description:", value: data.description, inline: false },
                { name: "When:", value: `<t:${unixTime}:F>`, inline: false },
                { name: "Channel:", value: channel.toString(), inline: false }
            )
            .setColor(color);

        if (data.messageUrl !== null) {
            embed.addFields({ name: "Message:", value: data.messageUrl, inline: false });
        }

        return embed;
    }

    static createErrorEmbed(title: string, reason: string): EmbedBuilder {
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(reason)
            .setColor(0xFF0000);
        return embed;
    }

    static async createReminderList(userId: string, guildId: string, newPos: number): Promise<WebhookEditMessageOptions> {
        const jobs = await this.agenda.jobs(
            { "data.userId": userId, "data.guildId": guildId },
            { nextRunAt: 1 } // sort
        );

        const count = jobs.length;
        if (count === 0) {
            const embed = ReminderBot.createErrorEmbed("Error getting list", "You have no reminders set.");
            return { embeds: [embed], components: [] };
        }

        if (newPos < 0) {
            newPos = count - 1;
        } else if (newPos >= count) {
            newPos = 0;
        }

        const currentJob = jobs[newPos];

        if (currentJob.attrs.nextRunAt == null) {
            throw Error("[ReminderBot] Got null or undefined date");
        }

        const embed = await this.createReminderEmbed(
            this.serializeListString(newPos, count),
            currentJob.attrs.nextRunAt,
            currentJob.attrs.data as ReminderJobData,
            0x8D8F91);
        const rowNextPrev = this.createBackNextRow();
        const btnDelPrompt = this.createButtonDeletePrompt(currentJob.attrs._id!.toHexString());
        const rowDel = new ActionRowBuilder().addComponents(btnDelPrompt) as ActionRowBuilder<ButtonBuilder>;
        return {
            embeds: [embed],
            components: [rowNextPrev, rowDel]
        };
    }

    static serializeListString(current: number, total: number): string {
        return `Reminder ${current + 1} of ${total}`;
    }

    static deserializeListString(str: string): number {
        const currentPageStr = str.substring("Reminder ".length, str.indexOf(" of "));
        return parseInt(currentPageStr) - 1;
    }

    static createBackNextRow(): ActionRowBuilder<ButtonBuilder> {
        const btnPrev = new ButtonBuilder()
            .setCustomId(ReminderBot.BTN_PREV)
            .setLabel("Previous Reminder")
            .setStyle(ButtonStyle.Primary);
        const btnNext = new ButtonBuilder()
            .setCustomId(ReminderBot.BTN_NEXT)
            .setLabel("Next Reminder")
            .setStyle(ButtonStyle.Primary);
        const rowNextPrev = new ActionRowBuilder().addComponents(btnPrev, btnNext) as ActionRowBuilder<ButtonBuilder>;
        return rowNextPrev;
    }

    static createButtonDeletePrompt(agendaObjectId: string): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(`${ReminderBot.BTN_DEL_PROMPT_PREFIX}${agendaObjectId}`)
            .setLabel("Delete Reminder")
            .setStyle(ButtonStyle.Danger);
    }

    static createButtonDeleteConfirm(agendaObjectId: string): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(`${ReminderBot.BTN_DEL_CONFIRM_PREFIX}${agendaObjectId}`)
            .setLabel("Confirm")
            .setStyle(ButtonStyle.Danger);
    }

    static deserializeObjectId(buttonId: string): ObjectId {
        let id;
        if (buttonId.startsWith(this.BTN_DEL_PROMPT_PREFIX)) {
            id = buttonId.substring(this.BTN_DEL_PROMPT_PREFIX.length);
        } else if (buttonId.startsWith(this.BTN_DEL_CONFIRM_PREFIX)) {
            id = buttonId.substring(this.BTN_DEL_CONFIRM_PREFIX.length);
        } else if (buttonId.startsWith(ReminderBot.BTN_DEL_CANCEL_PREFIX)) {
            id = buttonId.substring(this.BTN_DEL_CANCEL_PREFIX.length);
        } else {
            throw new Error(`[ReminderBot] Got unknown buttonId in deserializeObjectId(): ${buttonId}`);
        }

        const objectId = new ObjectId(id);
        return objectId;
    }

    static createButtonDeleteCancel(agendaObjectId: string): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(`${ReminderBot.BTN_DEL_CANCEL_PREFIX}${agendaObjectId}`)
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary);
    }

    static createDiscordUrl(guildId: string, channelId: string, messageId: string): string {
        return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    }
}
