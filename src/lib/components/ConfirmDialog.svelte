<script lang="ts">
	import { AlertDialog } from 'bits-ui';

	let {
		open = $bindable(false),
		title,
		description = '',
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		destructive = false,
		onconfirm
	}: {
		open?: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		destructive?: boolean;
		onconfirm: () => void;
	} = $props();
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Portal>
		<AlertDialog.Overlay class="fixed inset-0 z-40 bg-gray-900/40" />
		<AlertDialog.Content
			class="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl"
		>
			<AlertDialog.Title class="text-base font-semibold text-gray-900">
				{title}
			</AlertDialog.Title>
			{#if description}
				<AlertDialog.Description class="mt-2 text-sm text-gray-600">
					{description}
				</AlertDialog.Description>
			{/if}
			<div class="mt-5 flex justify-end gap-2">
				<AlertDialog.Cancel
					class="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
				>
					{cancelLabel}
				</AlertDialog.Cancel>
				<AlertDialog.Action
					onclick={() => {
						open = false;
						onconfirm();
					}}
					class="rounded-md px-3 py-1.5 text-sm font-semibold text-white shadow-sm {destructive
						? 'bg-red-600 hover:bg-red-500'
						: 'bg-indigo-600 hover:bg-indigo-500'}"
				>
					{confirmLabel}
				</AlertDialog.Action>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
