/* eslint-disable  @typescript-eslint/no-non-null-assertion */
import Agenda, { Job } from "agenda";
import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction,
    Client, ColorResolvable, EmbedBuilder, InteractionReplyOptions, InteractionUpdateOptions,
    WebhookEditMessageOptions } from "discord.js";
import { ObjectId } from "mongodb";
import { ReminderJobData } from "./ReminderJobData";

export abstract class AbstractReminderBot {
    protected abstract readonly CLASS_NAME: string;
    protected abstract readonly BTN_REM_DEL_CANCEL_PREFIX: string;
    protected abstract readonly BTN_REM_DEL_CONFIRM_PREFIX: string;
    protected abstract readonly BTN_REM_DEL_PROMPT_PREFIX: string;
    protected abstract readonly BTN_REM_NEXT: string;
    protected abstract readonly BTN_REM_PREV: string;
    protected abstract readonly REMINDER_TYPE: string;
    protected abstract readonly REMINDER_TYPE_TITLE: string;
    protected abstract readonly REMINDER_TRIGGERED_TITLE: string;
    protected abstract client: Client | null;
    protected abstract agenda: Agenda | null;

    // eslint-disable-next-line no-unused-vars
    abstract handleButtonClick(interaction: ButtonInteraction): Promise<void>;

    // eslint-disable-next-line no-unused-vars
    abstract handleReminderJob(job: Job): Promise<void>;

    async buildReminderEmbed(title: string, date: Date, data: ReminderJobData, color: ColorResolvable): Promise<EmbedBuilder> {
        const channel = await this.client!.channels.fetch(data.channelId);
        if (channel === null || !channel.isTextBased()) {
            const error = `[${this.CLASS_NAME}] Channel ID is unexpected: ${data.channelId}`;
            console.error(error);
            throw new Error(error);
        }

        const unixTime = Math.round(date.getTime() / 1000);
        const embed = new EmbedBuilder()
            .setTitle(title)
            .addFields(
                { name: "Description:", value: data.description, inline: false },
                { name: "Reminder Time:", value: `<t:${unixTime}:F>`, inline: false },
                { name: "Channel:", value: channel.toString(), inline: false }
            )
            .setColor(color);

        if (data.messageUrl !== null) {
            embed.addFields({ name: "Message Reference:", value: data.messageUrl, inline: false });
        }

        return embed;
    }

    async handleDeleteConfirm(interaction: ButtonInteraction, currentPos: number): Promise<void> {
        console.log(`[${this.CLASS_NAME}] handleDeleteConfirm() with customId: ${interaction.customId}`);
        try {
            const objId = this.deserializeObjectId(interaction.customId);
            const amountCanceled = await this.agenda!.cancel({ _id: objId });
            if (amountCanceled === 0) {
                throw new Error("No jobs were deleted");
            }

            const embed = new EmbedBuilder()
                .setTitle(`Deleted ${this.REMINDER_TYPE}`)
                .setColor(0x00FF00);
            const updateList = await this.buildReminderList(interaction.user.id, interaction.guildId!, currentPos - 1) as InteractionUpdateOptions ;
            await interaction.update(updateList);
            await interaction.followUp({ embeds: [embed], ephemeral: true });
        } catch (error) {
            if (error instanceof Error) {
                const errStr = `[${this.CLASS_NAME}] Error deleting reminder: ${error}`;
                console.error(errStr);
                const errorEmbed = this.buildErrorEmbed(`Failed to delete ${this.REMINDER_TYPE}`, error.message);
                await interaction.update({ components: [] });
                await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
            } else {
                const errStr = `[${this.CLASS_NAME}] Unknown error while deleting reminder: ${error}`;
                console.error(errStr);
                throw new Error(errStr);
            }
        }
    }

    async handleSlashList(interaction: ChatInputCommandInteraction): Promise<void> {
        console.log(`[${this.CLASS_NAME}] handleSlashList() from: ${interaction.user.id}`);
        const message = await this.buildReminderList(interaction.user.id, interaction.guildId!, 0);
        await interaction.reply(message as InteractionReplyOptions);
    }

    async buildReminderList(userId: string, guildId: string, newPos: number): Promise<InteractionReplyOptions | InteractionUpdateOptions > {
        const jobs = await this.agenda!.jobs(
            { "data.userId": userId, "data.guildId": guildId },
            { nextRunAt: 1 } // sort
        );

        const count = jobs.length;
        if (count === 0) {
            const embed = this.buildErrorEmbed("Error Getting Reminder List", `You have no ${this.REMINDER_TYPE}s set.`);
            return { embeds: [embed], components: [], ephemeral: true };
        }

        if (newPos < 0) {
            newPos = count - 1;
        } else if (newPos >= count) {
            newPos = 0;
        }

        const currentJob = jobs[newPos];

        if (currentJob.attrs.nextRunAt == null) {
            throw Error(`[${this.CLASS_NAME}] Got null or undefined date`);
        }

        const embed = await this.buildReminderEmbed(
            this.serializeListString(newPos, count),
            currentJob.attrs.nextRunAt,
            currentJob.attrs.data as ReminderJobData,
            0x8D8F91);
        const rowNextPrev = this.buildBackNextRow();
        const btnDelPrompt = this.buildButtonDeletePrompt(currentJob.attrs._id!.toHexString());
        const rowDel = new ActionRowBuilder().addComponents(btnDelPrompt) as ActionRowBuilder<ButtonBuilder>;
        return {
            embeds: [embed],
            components: [rowNextPrev, rowDel],
            ephemeral: true
        };
    }

    async handleDeletePrompt(interaction: ButtonInteraction): Promise<WebhookEditMessageOptions> {
        console.log(`[${this.CLASS_NAME}] handleDeletePrompt() with customId: ${interaction.customId}`);
        const objId = this.deserializeObjectId(interaction.customId).toHexString();

        const btnDelPrompt = this.buildButtonDeletePrompt(objId).setDisabled(true);
        const btnConfirm = this.buildButtonDeleteConfirm(objId);
        const btnCancel = this.buildButtonDeleteCancel(objId);
        const rowNextPrev = this.buildBackNextRow();
        const rowDel = new ActionRowBuilder().addComponents(btnDelPrompt, btnConfirm, btnCancel) as ActionRowBuilder<ButtonBuilder>;
        return {
            components: [rowNextPrev, rowDel]
        };
    }

    async handleDeleteCancel(interaction: ButtonInteraction): Promise<WebhookEditMessageOptions> {
        console.log(`[${this.CLASS_NAME}] handleDeleteCancel() with customId: ${interaction.customId}`);
        const objId = this.deserializeObjectId(interaction.customId).toHexString();

        const btnDelPrompt = this.buildButtonDeletePrompt(objId);
        const rowNextPrev = this.buildBackNextRow();
        const rowDel = new ActionRowBuilder().addComponents(btnDelPrompt) as ActionRowBuilder<ButtonBuilder>;
        return {
            components: [rowNextPrev, rowDel]
        };
    }

    async createReminder(jobData: ReminderJobData, when: Date | string, jobName: string): Promise<EmbedBuilder> {
        console.log(`[${this.CLASS_NAME}] createReminder() with data: ${JSON.stringify(jobData)} at ${when}`);
        let newReminder;
        let date;
        try {
            newReminder = this.agenda!.create(jobName, jobData);
            newReminder.schedule(when);
            date = newReminder.attrs.nextRunAt;
            if (date == null) {
                throw Error("[ReminderBot] Got null or undefined date");
            }
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[${this.CLASS_NAME}] Error creating reminder: ${error}`);
                const errorEmbed = this.buildErrorEmbed("Failed to create reminder", error.message);
                return errorEmbed;
            }

            console.error(`[${this.CLASS_NAME}] Error creating reminder: ${error}`);
            const errorEmbed = this.buildErrorEmbed("Failed to create reminder", "Unknown error");
            return errorEmbed;
        }

        try {
            await newReminder.save();
            const embed = await this.buildReminderEmbed("Created new reminder", date, jobData, 0x00FF00);
            return embed;
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[ReminderBot] Error saving reminder: ${error}`);
                const errorEmbed = this.buildErrorEmbed("Failed to save reminder", error.message);
                return errorEmbed;
            }

            console.error(`[ReminderBot] Error saving reminder: ${error}`);
            const errorEmbed = this.buildErrorEmbed("Failed to save reminder", "Unknown error");
            return errorEmbed;
        }
    }

    buildButtonDeleteCancel(agendaObjectId: string): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(`${this.BTN_REM_DEL_CANCEL_PREFIX}${agendaObjectId}`)
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary);
    }

    buildButtonDeletePrompt(agendaObjectId: string): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(`${this.BTN_REM_DEL_PROMPT_PREFIX}${agendaObjectId}`)
            .setLabel("Delete")
            .setStyle(ButtonStyle.Danger);
    }

    buildButtonDeleteConfirm(agendaObjectId: string): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(`${this.BTN_REM_DEL_CONFIRM_PREFIX}${agendaObjectId}`)
            .setLabel("Confirm")
            .setStyle(ButtonStyle.Danger);
    }

    buildBackNextRow(): ActionRowBuilder<ButtonBuilder> {
        const btnPrev = new ButtonBuilder()
            .setCustomId(this.BTN_REM_PREV)
            .setLabel("Previous")
            .setStyle(ButtonStyle.Primary);
        const btnNext = new ButtonBuilder()
            .setCustomId(this.BTN_REM_NEXT)
            .setLabel("Next")
            .setStyle(ButtonStyle.Primary);
        const rowNextPrev = new ActionRowBuilder().addComponents(btnPrev, btnNext) as ActionRowBuilder<ButtonBuilder>;
        return rowNextPrev;
    }

    deserializeObjectId(buttonId: string): ObjectId {
        let id;
        if (buttonId.startsWith(this.BTN_REM_DEL_PROMPT_PREFIX)) {
            id = buttonId.substring(this.BTN_REM_DEL_PROMPT_PREFIX.length);
        } else if (buttonId.startsWith(this.BTN_REM_DEL_CONFIRM_PREFIX)) {
            id = buttonId.substring(this.BTN_REM_DEL_CONFIRM_PREFIX.length);
        } else if (buttonId.startsWith(this.BTN_REM_DEL_CANCEL_PREFIX)) {
            id = buttonId.substring(this.BTN_REM_DEL_CANCEL_PREFIX.length);
        } else {
            throw new Error(`[${this.CLASS_NAME}] Got unknown buttonId in deserializeObjectId(): ${buttonId}`);
        }

        const objectId = new ObjectId(id);
        return objectId;
    }

    serializeListString(current: number, total: number): string {
        return `${this.REMINDER_TYPE_TITLE} ${current + 1} of ${total}`;
    }

    deserializeListString(str: string): number {
        const currentPageStr = str.substring(`${this.REMINDER_TYPE_TITLE} `.length, str.indexOf(" of "));
        return parseInt(currentPageStr) - 1;
    }

    buildErrorEmbed(title: string, reason: string): EmbedBuilder {
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(reason)
            .setColor(0xFF0000);
        return embed;
    }
}