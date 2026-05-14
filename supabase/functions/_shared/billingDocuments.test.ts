/// <reference lib="deno.ns" />
// deno-lint-ignore-file no-explicit-any
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { syncBillingDocumentsForPayment } from "./billingDocuments.ts";

function createFakeClient() {
  const state = {
    documents: [] as any[],
    events: [] as any[],
    paymentUpdates: [] as any[],
  };

  const tableApi = (table: string, op?: string, payload?: any) => {
    const filters: Record<string, unknown> = {};
    const api: any = {
      select() {
        return api;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return api;
      },
      async maybeSingle() {
        if (table === "billing_documents" && op === "select") {
          return {
            data: state.documents.find((doc) =>
              doc.source === filters.source &&
              doc.document_type === filters.document_type &&
              doc.source_reference === filters.source_reference
            ) ?? null,
            error: null,
          };
        }
        if (table === "payment_transactions" && op === "update") {
          state.paymentUpdates.push(payload);
          return {
            data: { id: filters.id, ...basePayment, ...payload },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      async single() {
        if (table === "billing_documents" && op === "insert") {
          const doc = { id: `doc_${state.documents.length + 1}`, ...payload };
          state.documents.push(doc);
          return { data: doc, error: null };
        }
        if (table === "billing_documents" && op === "update") {
          const index = state.documents.findIndex((doc) => doc.id === filters.id);
          assert(index >= 0);
          state.documents[index] = { ...state.documents[index], ...payload };
          return { data: state.documents[index], error: null };
        }
        return { data: null, error: null };
      },
    };
    return api;
  };

  const client: any = {
    auth: {
      admin: {
        async getUserById() {
          return {
            data: {
              user: {
                email: "mediaforge2026@gmail.com",
                user_metadata: { first_name: "MediaForge" },
              },
            },
          };
        },
      },
    },
    from(table: string) {
      return {
        select() {
          return tableApi(table, "select");
        },
        update(payload: any) {
          return tableApi(table, "update", payload);
        },
        insert(payload: any) {
          if (table === "billing_document_events") {
            state.events.push(payload);
            return Promise.resolve({ data: payload, error: null });
          }
          return tableApi(table, "insert", payload);
        },
      };
    },
  };

  return { client, state };
}

const basePayment = {
  id: "pay_test_1",
  user_id: "user_test_1",
  organization_id: null,
  payment_scope: "user",
  stripe_payment_intent_id: "pi_test_1",
  stripe_session_id: "cs_test_1",
  amount_thb: 1000,
  credits_added: 5000,
  currency: "thb",
  checkout_metadata: { package_name: "E2E Test Package" },
};

const fakeStripe: any = {
  paymentIntents: {
    async retrieve() {
      return {
        id: "pi_test_1",
        customer: "cus_test_1",
        latest_charge: {
          id: "ch_test_1",
          receipt_url: "https://pay.stripe.com/receipts/test",
          receipt_number: "RCPT-STRIPE-1",
          invoice: "in_test_1",
          amount: 100000,
          currency: "thb",
        },
      };
    },
  },
  invoices: {
    async retrieve() {
      return {
        id: "in_test_1",
        number: "INV-STRIPE-1",
        customer: "cus_test_1",
        amount_paid: 100000,
        currency: "thb",
        hosted_invoice_url: "https://invoice.stripe.com/i/test",
        invoice_pdf: "https://invoice.stripe.com/i/test.pdf",
      };
    },
  },
};

Deno.test("syncBillingDocumentsForPayment caches Stripe document fields and creates receipt + invoice", async () => {
  const { client, state } = createFakeClient();

  const result = await syncBillingDocumentsForPayment(client, fakeStripe, basePayment, { sendEmail: false });

  assertEquals(result.documents.length, 2);
  assertEquals(state.documents.map((doc) => doc.document_type).sort(), ["invoice", "receipt"]);
  assertEquals(state.paymentUpdates.length, 1);
  assertEquals(state.paymentUpdates[0].stripe_customer_id, "cus_test_1");
  assertEquals(state.paymentUpdates[0].invoice_pdf_url, "https://invoice.stripe.com/i/test.pdf");
  assertEquals(state.documents.find((doc) => doc.document_type === "invoice")?.invoice_pdf_url, "https://invoice.stripe.com/i/test.pdf");
});

Deno.test("syncBillingDocumentsForPayment keeps generated document numbers stable on resync", async () => {
  const { client, state } = createFakeClient();
  const stripeWithoutNumbers = {
    ...fakeStripe,
    paymentIntents: {
      async retrieve() {
        return {
          id: "pi_test_1",
          customer: "cus_test_1",
          latest_charge: {
            id: "ch_test_1",
            receipt_url: "https://pay.stripe.com/receipts/test",
            invoice: "in_test_1",
            amount: 100000,
            currency: "thb",
          },
        };
      },
    },
    invoices: {
      async retrieve() {
        return {
          id: "in_test_1",
          customer: "cus_test_1",
          hosted_invoice_url: "https://invoice.stripe.com/i/test",
          invoice_pdf: "https://invoice.stripe.com/i/test.pdf",
        };
      },
    },
  };

  await syncBillingDocumentsForPayment(client, stripeWithoutNumbers, basePayment, { sendEmail: false });
  const firstNumbers = state.documents.map((doc) => doc.document_number);

  await syncBillingDocumentsForPayment(client, stripeWithoutNumbers, basePayment, { sendEmail: false });
  const secondNumbers = state.documents.map((doc) => doc.document_number);

  assertEquals(secondNumbers, firstNumbers);
});

