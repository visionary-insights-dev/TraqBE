import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const ORG = {
  name: 'Talent Makers Foundation',
  slug: 'tmf',
};

const SEED_USERS = [
  {
    email: 'admin@tmf.com',
    password: 'Admin1234!',
    name: 'TMF Admin',
    role: Role.SUPER_ADMIN,
  },
  {
    email: 'mentor@tmf.com',
    password: 'Mentor1234!',
    name: 'Test Mentor',
    role: Role.MENTOR,
  },
  {
    email: 'scholar@tmf.com',
    password: 'Scholar1234!',
    name: 'Test Scholar',
    role: Role.SCHOLAR,
  },
] as const;

async function main() {
  // Upsert the organization (idempotent — keyed on unique slug).
  const organization = await prisma.organization.upsert({
    where: { slug: ORG.slug },
    update: { name: ORG.name },
    create: {
      name: ORG.name,
      slug: ORG.slug,
    },
  });

  for (const seedUser of SEED_USERS) {
    // Hash the password with argon2id (matches auth.service.ts hashing).
    const passwordHash = await argon2.hash(seedUser.password, { type: argon2.argon2id });

    // Upsert the user (idempotent — keyed on unique email). Password is only set
    // on create so re-seeding never resets an existing user's credentials.
    const user = await prisma.user.upsert({
      where: { email: seedUser.email },
      update: {},
      create: {
        email: seedUser.email,
        name: seedUser.name,
        password_hash: passwordHash,
      },
    });

    // Grant the role within the org (join table — keyed on unique
    // [organization_id, user_id, role]).
    await prisma.userRole.upsert({
      where: {
        organization_id_user_id_role: {
          organization_id: organization.id,
          user_id: user.id,
          role: seedUser.role,
        },
      },
      update: {},
      create: {
        organization_id: organization.id,
        user_id: user.id,
        role: seedUser.role,
      },
    });

    console.log(`Seeded user: ${user.email} (${seedUser.role})`);
  }

  console.log(`Seeded organization: ${organization.name} (${organization.slug})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
