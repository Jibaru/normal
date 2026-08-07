"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const faqs = [
  {
    answer:
      "MCP is a standard that lets compatible AI applications use external tools and context. Normal provides those tools for your connected WhatsApp account.",
    question: "What is Normal?",
  },
  {
    answer:
      "Every outbound messaging tool invocation requires Client Confirmation in the MCP Client.",
    question: "Can an MCP Client send messages without me?",
  },
  {
    answer:
      "Yes. Connection metadata, the WhatsApp Directory, Stored Messages, and sending use separate permissions.",
    question: "Can I allow reading without sending?",
  },
  {
    answer:
      "Normal observes supported messages after your WhatsApp Connection becomes active. It does not claim access to conversations from before Connection Setup.",
    question: "Does Normal import my entire WhatsApp history?",
  },
  {
    answer: "Yes. You can revoke an MCP Authorization whenever you want.",
    question: "Can I revoke access?",
  },
] as const;

export function FaqAccordion() {
  return (
    <Accordion
      className="faq-list"
      defaultValue={["faq-0", "faq-2", "faq-3", "faq-4"]}
      multiple
    >
      {faqs.map(({ answer, question }, index) => (
        <AccordionItem key={question} value={`faq-${index}`}>
          <AccordionTrigger>{question}</AccordionTrigger>
          <AccordionContent>
            <p>{answer}</p>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
