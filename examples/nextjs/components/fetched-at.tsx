"use client";

export function FetchedAt({ date }: { date: string }) {
    const formatted = new Date(date).toLocaleTimeString();

    return <span>{formatted}</span>;
}