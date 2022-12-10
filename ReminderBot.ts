/* eslint-disable  @typescript-eslint/no-non-null-assertion */
import { ContextMenuCommandBuilder, SlashCommandBuilder } from "@discordjs/builders";
import { ActionRowBuilder, ApplicationCommandType, ButtonInteraction, ChatInputCommandInteraction,
    Client, CommandInteraction, GatewayIntentBits,
    MessageContextMenuCommandInteraction, ModalBuilder, ModalSubmitInteraction, TextInputBuilder,
    TextInputStyle, WebhookEditMessageOptions } from "discord.js";
import { BotInterface } from "../../BotInterface";
import { readYamlConfig } from "../../utils/ConfigUtils";
import { ReminderConfig } from "./ReminderConfig";
import { createAgenda } from "./common/ReminderUtils";
import { ReminderJobData } from "./common/ReminderJobData";
import { AbstractReminderBot } from "./common/AbstractReminderBot";
import Agenda, { Job } from "agenda";

export class ReminderBot extends AbstractReminderBot implements BotInterface {
    private static readonly CONTEXT_CREATE_NAME = "Create reminder";
    private static readonly SUBCMD_CREATE = "create";
    private static readonly SUBCMD_LIST = "list";
    private static readonly CREATE_MODAL_PREFIX = "ReminderBot_createReminderModal__";
    private static readonly CREATE_MODAL_SUFFIX_NOREPLY = "noreply";
    private static readonly INPUT_TIME_ID = "ReminderBot_timeTextInput";
    private static readonly INPUT_DESCRIPTION_ID = "ReminderBot_descriptionInput";
    private static readonly MAX_DESCRIPTION_LENGTH = 80;
    private static readonly AGENDA_JOB_REMINDER = "reminder";

    CLASS_NAME = "ReminderBot";
    BTN_REM_PREV = "ReminderBot_btnPrev";
    BTN_REM_NEXT = "ReminderBot_btnNext";
    BTN_REM_DEL_PROMPT_PREFIX = "ReminderBot_btnDeletePrompt__";
    BTN_REM_DEL_CONFIRM_PREFIX = "ReminderBot_btnDeleteConfirm__";
    BTN_REM_DEL_CANCEL_PREFIX = "ReminderBot_btnDeleteCancel__";
    REMINDER_TYPE = "reminder";
    REMINDER_TYPE_TITLE = "Reminder";
    REMINDER_TRIGGERED_TITLE = "Reminder Triggered";
    client: Client | null = null;
    agenda: Agenda | null = null;

    private static instance: ReminderBot;
    intents: GatewayIntentBits[];
    commands: (SlashCommandBuilder | ContextMenuCommandBuilder)[];
    private slashReminder: SlashCommandBuilder;
    private contextReminder: ContextMenuCommandBuilder;

    constructor() {
        super();

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

        if (ReminderBot.instance !== undefined) {
            return;
        }
        ReminderBot.instance = this;
    }

    async init(): Promise<string | null> {
        try {
            const config = await readYamlConfig<ReminderConfig>(import.meta, "config.yaml");
            this.agenda = await createAgenda(config.mongoDb.url, config.mongoDb.user,
                config.mongoDb.password, config.mongoDb.agendaCollection);
            this.agenda!.define(ReminderBot.AGENDA_JOB_REMINDER, this.handleReminderJob);
            await this.agenda.start();
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
        } else if (interaction.user.id === this.client!.user!.id) {
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
        this.client = client;
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

    async handleSlashCreate(interaction: ChatInputCommandInteraction): Promise<void> {
        console.log(`[ReminderBot] handleSlashCreate() from: ${interaction.user.id}`);
        const modal = ReminderBot.createQuoteModal(null);
        await interaction.showModal(modal);
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
            messageUrl: messageUrl
        };

        console.log(`[ReminderBot] handleCreateModalSubmit() with info: ${JSON.stringify(jobData)}`);
        const embed = await this.createReminder(jobData, timeStr, ReminderBot.AGENDA_JOB_REMINDER);
        await interaction.editReply({
            embeds: [embed]
        });
    }

    async handleButtonClick(interaction: ButtonInteraction): Promise<void> {
        if (interaction.customId !== this.BTN_REM_PREV &&
            interaction.customId !== this.BTN_REM_NEXT &&
            !interaction.customId.startsWith(this.BTN_REM_DEL_PROMPT_PREFIX) &&
            !interaction.customId.startsWith(this.BTN_REM_DEL_CONFIRM_PREFIX) &&
            !interaction.customId.startsWith(this.BTN_REM_DEL_CANCEL_PREFIX)) {
            return;
        }

        const interactUser = interaction.user.id;
        const slashUser = interaction.message.interaction!.user.id;
        if (interactUser !== slashUser) {
            await interaction.update("");
            return;
        }

        const currentPos = this.deserializeListString(interaction.message.embeds[0].title!);
        let newUpdate: WebhookEditMessageOptions | null = null;
        if (interaction.customId === this.BTN_REM_PREV) {
            newUpdate = await this.buildReminderList(interactUser, interaction.guildId!, currentPos - 1);
        } else if (interaction.customId === this.BTN_REM_NEXT) {
            newUpdate = await this.buildReminderList(interactUser, interaction.guildId!, currentPos + 1);
        } else if (interaction.customId.startsWith(this.BTN_REM_DEL_PROMPT_PREFIX)) {
            newUpdate = await this.handleDeletePrompt(interaction);
        }  else if (interaction.customId.startsWith(this.BTN_REM_DEL_CONFIRM_PREFIX)) {
            await this.handleDeleteConfirm(interaction, currentPos);
        } else if (interaction.customId.startsWith(this.BTN_REM_DEL_CANCEL_PREFIX)) {
            newUpdate = await this.handleDeleteCancel(interaction);
        }

        if (newUpdate !== null) {
            await interaction.update(newUpdate);
        }

        return;
    }

    async handleReminderJob(job: Job): Promise<void> {
        try {
            if (job.attrs.data === undefined || job.attrs.lastRunAt === undefined) {
                throw new Error(`[${ReminderBot.instance.CLASS_NAME}] Bad job data: ${job.toJSON()}`);
            }

            ReminderBot.instance.handleReminderJob.bind(ReminderBot.instance);
            const data = job.attrs.data as ReminderJobData;
            const embed = await ReminderBot.instance.buildReminderEmbed(
                ReminderBot.instance.REMINDER_TRIGGERED_TITLE, job.attrs.lastRunAt, data, 0xFFFFFF);
            const channel = await ReminderBot.instance.client!.channels.fetch(data.channelId);
            const user = await ReminderBot.instance.client!.users.fetch(data.userId);
            if (channel === null || !channel.isTextBased()) {
                const error = `[${ReminderBot.instance.CLASS_NAME}] Channel ID is unexpected: ${data.channelId}`;
                throw new Error(error);
            }

            await channel.send({
                content: user.toString(),
                embeds: [embed]
            });

            await job.remove();
        } catch (error) {
            const errStr = `[${ReminderBot.instance.CLASS_NAME}] Failed to finish reminder job: ${error}`;
            console.error(errStr);
            job.fail(errStr);
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

    static createDiscordUrl(guildId: string, channelId: string, messageId: string): string {
        return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    }
}
