export type ReceiptDataSnapshot = {
    payment: {
      id: string;
      amount: any;
      tipAmount: any;
      totalAmount: number;
      method: string;
      status: string;
      createdAt: Date;
    };
    venue: {
      id: string;
      name: string;
      address: string;
      city: string;
      state: string;
      zipCode: string;
      phone: string;
      logo: string | null;
    };
    order: {
      id: string;
      number: number;
      items: Array<{
        name: string;
        quantity: number;
        price: number;
        totalPrice: number;
        modifiers: Array<{
          name: string;
          price: number;
        }>;
      }>;
      subtotal: any;
      tax: any;
      total: any;
      createdAt: Date;
    };
    processedBy: {
      name: string;
    } | null;
    customer: {
      name: string;
      email: string | null;
    } | null;
  };
  